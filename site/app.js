// The page. One Board object, three views of it, an edit log, and a review.
//
// Every edit goes through site/ops.js, which is the same nine operations as
// harness/ops.py. Nothing here reaches into the board directly, so the edit log
// is a complete record and undo is just replaying it backwards.

import { applyEdit, findFootprint, OPS, undo } from "./ops.js";
import {
  attachPanZoom,
  clearMarks,
  divergence,
  highlightNets,
  markDivergence,
  markRefs,
  markDatasheets,
  packageFacts,
  renderBoard,
  renderFootprint,
} from "./render.js";
import { islandCounts } from "./copper.js";
import { MEASURED, ROLES } from "./graph.js";
import { summarise } from "./kicad.js";
import { baseType, isGround, isRail } from "./checks.js";
import { coverage, needsDatasheet } from "./datasheets.js";
import { attach, detach, docFor, factsOf, loadDocs, pagesOfPdf } from "./docs.js";
import { attachUpload } from "./upload.js";
import {
  budget,
  coolingDownMs,
  getSample,
  grade,
  MIN_INTERVAL_MS,
  review,
  reviewCache,
  ReviewUnavailable,
} from "./review.js";

const $ = (id) => document.getElementById(id);
const clone = (value) => JSON.parse(JSON.stringify(value));

const SAMPLE = JSON.parse($("board-data").textContent);

// The board the page is currently working on, and the one Reset goes back to.
// It starts as the sample and is replaced whole when a project is loaded.
let ORIGINAL = SAMPLE;
let custom = null;

const state = {
  board: clone(SAMPLE),
  log: [],
  view: "routing",
  selection: null,
  sample: null,
  verdict: null,
  reviewError: null,
  focused: null,
  divergence: { stale: [], stranded: [] },
  //: The graph's steps as they happen, so the page can show it running.
  steps: [],
  reviewing: false,
  //: The first half of a pin swap, waiting for the pin to swap it with.
  armed: null,
};

let panzoom = null;
let keptView = null;

// --------------------------------------------------------------------- views

function currentSvg() {
  return $("stage").firstElementChild;
}

function drawView({ keepZoom = true } = {}) {
  const stage = $("stage");
  if (keepZoom && panzoom) keptView = panzoom.view;
  stage.textContent = "";

  // One view: the board with its copper. The schematic and bare-layout views
  // were dropped — a schematic here was KiCad's picture, which cannot be edited
  // and cannot be produced for a board someone uploads, and layout was routing
  // with the interesting half switched off.
  const svg = renderBoard(state.board, { copper: true });
  svg.dataset.view = "board";
  stage.appendChild(svg);

  markDatasheets(svg, state.board, coverage(state.board));
  // Clicking the badge is what someone does when they notice it, so it opens
  // the dialog rather than doing nothing and leaving them to find the part in
  // the rail. The part is selected too, so the rail agrees with the screen.
  //
  // The listener goes on the layer, not on the badges. `markDatasheets` empties
  // and refills the layer on every repaint, so a badge holding its own listener
  // loses it the moment anything changes - which included the repaint that runs
  // as soon as the stored documents finish loading, so it was dead on arrival.
  const marks = svg.querySelector(".datasheet-marks");
  if (marks) {
    marks.addEventListener("pointerdown", (e) => e.stopPropagation());
    marks.addEventListener("pointerup", (e) => {
      const badge = e.target.closest(".ds-badge");
      if (!badge) return;
      e.stopPropagation();
      select({ kind: "part", ref: badge.dataset.ref });
      openDocs(badge.dataset.ref);
    });
  }
  // The badges are drawn from what is in memory, so a board whose
  // documents are still being read shows them a moment later.
  loadDocs(state.board.meta.name).then(paintDatasheets);
  panzoom = attachPanZoom(svg, {
    onPointerDown: startDrag,
    onTap: (target) => select(target ? describe(target) : null),
  });
  if (keepZoom && keptView && keptView.w) {
    svg.setAttribute(
      "viewBox",
      `${keptView.x} ${keptView.y} ${keptView.w} ${keptView.h}`
    );
  }
  applySelectionToSvg();
  paintMarks();
  return svg;
}

function describe(node) {
  const { kind, ref, id, pad, net } = node.dataset;
  if (kind === "symbol" || kind === "footprint") return { kind: "part", ref };
  if (kind === "pad") return { kind: "pad", ref, pad, net };
  return { kind, id, net };
}

// ------------------------------------------------------------------ dragging

function startDrag(event, target, at) {
  const group = target.closest('[data-kind="footprint"]');
  if (!group) return false;

  const fp = findFootprint(state.board, group.dataset.ref);
  const grab = { dx: fp.x - at.x, dy: fp.y - at.y, x0: fp.x, y0: fp.y, ref: fp.ref };
  let moved = false;
  const svg = currentSvg();

  const move = (moveEvent) => {
    const now = panzoom.toBoard(moveEvent);
    const nx = now.x + grab.dx;
    const ny = now.y + grab.dy;
    if (!moved && Math.hypot(nx - grab.x0, ny - grab.y0) < 0.05) return;
    moved = true;
    // Preview by moving the group; the operation is recorded once, on release,
    // so a drag is one entry in the log rather than two hundred.
    fp.x = nx;
    fp.y = ny;
    group.setAttribute(
      "transform",
      `translate(${nx.toFixed(3)} ${ny.toFixed(3)})` + (fp.rot ? ` rotate(${(-fp.rot).toFixed(3)})` : "")
    );
  };

  const up = () => {
    svg.removeEventListener("pointermove", move);
    svg.removeEventListener("pointerup", up);
    svg.removeEventListener("pointercancel", up);
    const [x, y] = [fp.x, fp.y];
    fp.x = grab.x0;
    fp.y = grab.y0;
    if (moved) record({ op: "move_footprint", args: { ref: grab.ref, x, y } });
    else select({ kind: "part", ref: grab.ref });
  };

  svg.setPointerCapture(event.pointerId);
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerup", up);
  svg.addEventListener("pointercancel", up);
  return true;
}

// -------------------------------------------------------------- edit plumbing

/**
 * Operations that set a value rather than change it by one.
 *
 * Each of these carries the whole new state in its arguments, so a run of them
 * against one target can be collapsed to the last: replaying `rotated to 270`
 * lands where replaying 90, 180, 270 lands. That is what makes the collapse
 * safe to do to the log itself rather than only to the display - the log is the
 * edit list, and it still has to reproduce the board.
 */
const ABSOLUTE = new Set(["set_value", "move_footprint", "rotate_footprint", "move_pin"]);

/** What an edit is about, so two edits to the same thing can be recognised. */
const target = (entry) =>
  `${entry.op}:${entry.args.ref || ""}:${entry.args.pin || ""}`;

function record(edit) {
  try {
    const entry = applyEdit(state.board, edit);
    const last = state.log[state.log.length - 1];
    if (
      last &&
      ABSOLUTE.has(entry.op) &&
      target(last) === target(entry)
    ) {
      // Undo has to reach the state before the run began, not before its last
      // step, so the older entry's record of what it replaced survives and the
      // newer one's is dropped.
      state.log[state.log.length - 1] = {
        ...entry,
        from_net: last.from_net ?? entry.from_net,
        from_value: last.from_value ?? entry.from_value,
        from_xy: last.from_xy ?? entry.from_xy,
        from_rot: last.from_rot ?? entry.from_rot,
      };
    } else {
      state.log.push(entry);
    }
  } catch (error) {
    flash(error.message);
    return false;
  }
  state.verdict = null;
  state.focused = null;
  state.reviewError = null;
  afterChange();
  return true;
}

function afterChange() {
  $("board-stats").textContent = summarise(state.board);
  drawView();
  renderLog();
  renderInspector();
  renderReview();
}

function undoLast() {
  if (!state.log.length) return;
  undo(state.board, state.log);
  state.verdict = null;
  afterChange();
}

function resetBoard() {
  state.board = clone(ORIGINAL);
  state.log = [];
  state.verdict = null;
  state.reviewError = null;
  state.focused = null;
  state.selection = null;
  afterChange();
}

/**
 * Swap in a board read from the visitor's own files.
 *
 * `null` goes back to the sample. The presets are turned off for a loaded
 * board: each one names particular parts and particular track ids on this
 * board, and pretending otherwise would just throw.
 */
function loadBoard(board, notes = [], files = null) {
  ORIGINAL = board || SAMPLE;
  custom = board ? { notes, files, name: board.meta.name } : null;
  state.board = clone(ORIGINAL);
  state.log = [];
  state.verdict = null;
  state.reviewError = null;
  state.focused = null;
  state.selection = null;
  keptView = null;

  setView("routing");
  renderSource();
  afterChange();
}

function renderSource() {
  const panel = $("source");
  const stats = state.board.layout;
  // Both labels come from the board that is loaded. The sample used to be
  // named in the source, which read as though the tool were built around it.
  $("board-id").textContent = custom ? custom.name : "";

  if (!custom) {
    panel.innerHTML = `<p class="muted">${escapeHtml(summarise(state.board))}</p>`;
  } else {
    panel.innerHTML = `
      <p class="loaded"><b>${escapeHtml(custom.name)}</b> ${escapeHtml(summarise(state.board))}</p>
      ${custom.notes.map((n) => html`<p class="hint">${n}</p>`).join("")}
      <button class="btn" id="unload">Back to the sample board</button>`;
    panel.querySelector("#unload").addEventListener("click", () => loadBoard(null));
  }
}


// ------------------------------------------------------------------ selection

function select(selection) {
  state.armed = null;
  state.selection = selection;
  applySelectionToSvg();
  renderInspector();
}

function applySelectionToSvg() {
  const svg = currentSvg();
  if (!svg) return;
  for (const node of svg.querySelectorAll(".selected")) node.classList.remove("selected");
  const sel = state.selection;
  if (!sel) {
    highlightNets(svg, []);
    return;
  }
  let nets = [];
  if (sel.kind === "part") {
    for (const node of svg.querySelectorAll(`[data-ref="${cssEscape(sel.ref)}"]`)) {
      node.classList.add("selected");
    }
    nets = netsOf(sel.ref);
  } else if (sel.kind === "pad") {
    for (const node of svg.querySelectorAll(
      `[data-ref="${cssEscape(sel.ref)}"][data-pad="${cssEscape(sel.pad)}"]`
    )) {
      node.classList.add("selected");
    }
    nets = [sel.net];
  } else {
    for (const node of svg.querySelectorAll(`[data-id="${cssEscape(sel.id)}"]`)) {
      node.classList.add("selected");
    }
    nets = [sel.net];
  }
  highlightNets(svg, nets);
}

const cssEscape = (value) => String(value).replace(/["\\]/g, "\\$&");

function netsOf(ref) {
  const out = [];
  for (const net of state.board.nets) {
    if (net.nodes.some((n) => n.ref === ref)) out.push(net.name);
  }
  return out;
}

function pinsOf(ref) {
  const out = [];
  for (const net of state.board.nets) {
    for (const node of net.nodes) {
      if (node.ref === ref) out.push({ ...node, net: net.name });
    }
  }
  return out.sort((a, b) => (a.pin.length - b.pin.length) || (a.pin < b.pin ? -1 : 1));
}

// ------------------------------------------------------------------ inspector

function html(strings, ...values) {
  return strings.reduce(
    (out, part, i) => out + part + (i < values.length ? escapeHtml(values[i]) : ""),
    ""
  );
}

/** One labelled line of a finding. Empty ones are left out rather than shown blank. */
function bullet(label, text) {
  if (!text) return "";
  return `<span class="bullet"><em>${label}</em>${escapeHtml(text)}</span>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]
  );
}

function renderInspector() {
  const panel = $("inspector");
  const sel = state.selection;
  if (!sel) {
    panel.innerHTML = `<p class="muted">Click a part, a track, a via or a pour to
      edit it. Drag a part to move it.</p>`;
    return;
  }
  if (sel.kind === "part") return renderPartInspector(panel, sel.ref);
  if (sel.kind === "pad") return renderPadInspector(panel, sel);
  if (sel.kind === "track") return renderTrackInspector(panel, sel.id);
  if (sel.kind === "via") return renderViaInspector(panel, sel.id);
  if (sel.kind === "zone") return renderZoneInspector(panel, sel.id);
}

function renderPartInspector(panel, ref) {
  const comp = state.board.components.find((c) => c.ref === ref);
  const fp = state.board.layout.footprints.find((f) => f.ref === ref);
  if (!comp) {
    panel.innerHTML = html`<p class="muted">${ref} is not in the net list.</p>`;
    return;
  }
  const pins = pinsOf(ref);
  const netNames = [...new Set(state.board.nets.map((n) => n.name))].sort();
  const pk = fp ? packageFacts(fp) : null;
  const elec = electrics(pins);

  panel.innerHTML = `
    <div class="ins-head">
      <span class="ref">${escapeHtml(ref)}</span>
      <span class="val">${escapeHtml(comp.value)}</span>
    </div>
    ${comp.description ? html`<p class="desc">${comp.description}</p>` : ""}

    <div class="fp-view" id="ins-fp"></div>

    <dl class="facts">
      <dt>Package</dt><dd>${escapeHtml((comp.footprint || "").split(":").pop())}</dd>
      ${pk ? packageRows(pk) : ""}
      ${fp ? html`<dt>Placed</dt><dd>${mm2(fp.x)}, ${mm2(fp.y)} mm · ${Number(fp.rot)}° · ${fp.layer}.Cu</dd>` : ""}
      ${fp && fp.silk !== ref ? html`<dt>Silkscreen</dt><dd>${fp.silk}</dd>` : ""}
      ${elec.rails.length ? html`<dt>Rails</dt><dd>${elec.rails.join(", ")}</dd>` : ""}
      <dt>Grounded</dt><dd>${elec.grounds.length ? escapeHtml(elec.grounds.join(", ")) : "no ground pin"}</dd>
      ${
        elec.roles.length
          ? `<dt>Pin roles</dt><dd>${escapeHtml(
              elec.roles.map(([kind, n]) => `${n}× ${kind.replace(/_/g, " ")}`).join(", ")
            )}</dd>`
          : ""
      }
      ${elec.floating ? html`<dt>Unconnected</dt><dd>${elec.floating} of ${pins.length} pins</dd>` : ""}
    </dl>

    <h4 class="eyebrow">Edit</h4>
    <label class="field">
      <span>Value</span>
      <input id="ins-value" type="text" value="${escapeHtml(comp.value)}" spellcheck="false">
    </label>
    ${
      fp
        ? `<div class="field-pair">
            <label class="field"><span>X mm</span>
              <input id="ins-x" type="number" step="0.1" value="${mm2(fp.x)}"></label>
            <label class="field"><span>Y mm</span>
              <input id="ins-y" type="number" step="0.1" value="${mm2(fp.y)}"></label>
          </div>
          <div class="row">
            <button class="btn" data-act="rot" data-deg="90">Rotate 90°</button>
            <button class="btn" data-act="rot" data-deg="180">180°</button>
            <button class="btn" data-act="rot" data-deg="270">270°</button>
          </div>`
        : ""
    }

    <h4 class="eyebrow">Pins <span class="count">${pins.length}</span></h4>
    <input class="pin-filter" id="ins-filter" type="search" placeholder="Filter pins or nets"
           spellcheck="false" value="${escapeHtml(state.pinFilter || "")}">
    <ul class="pins">
      ${pins
        .map((pin) => {
          const armed = state.armed && state.armed.ref === ref && state.armed.pin === pin.pin;
          const role = pinRole(pin);
          return `<li data-hay="${escapeHtml(
            `${pin.pin} ${pin.function || ""} ${pin.net}`.toLowerCase()
          )}">
            <b>${escapeHtml(pin.pin)}</b>
            <span class="fn">${escapeHtml(pin.function || "")}</span>
            ${role ? `<em class="role role-${escapeHtml(role)}">${escapeHtml(role.replace(/_/g, " "))}</em>` : ""}
            <select class="net-pick" data-pin="${escapeHtml(pin.pin)}">
              ${netNames
                .map(
                  (name) =>
                    `<option value="${escapeHtml(name)}"${name === pin.net ? " selected" : ""}>${escapeHtml(name)}</option>`
                )
                .join("")}
            </select>
            <button class="swap${armed ? " armed" : ""}" data-swap="${escapeHtml(pin.pin)}"
              title="Swap this pin with another">&#8646;</button>
          </li>`;
        })
        .join("")}
    </ul>
    ${state.armed && state.armed.ref === ref
      ? html`<p class="hint armed-hint">Pin ${state.armed.pin} is armed. Pick the pin to swap it with.</p>`
      : `<p class="hint">⇆ swaps two pins in one move. <kbd>R</kbd> rotates,
         <kbd>Esc</kbd> deselects.</p>`}
    <p class="hint">A net change edits the net list only. The copper keeps its
      routing, and the board shows where the two now disagree.</p>
  `;

  if (fp) $("ins-fp").appendChild(renderFootprint(fp));

  const value = $("ins-value");
  value.addEventListener("change", () => {
    if (value.value !== comp.value) record({ op: "set_value", args: { ref, value: value.value } });
  });
  // Typed coordinates go through the same move the drag does, so one undo
  // entry covers either way of having moved the part.
  const nudge = () => {
    const x = Number($("ins-x").value);
    const y = Number($("ins-y").value);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (Math.abs(x - fp.x) < 1e-4 && Math.abs(y - fp.y) < 1e-4) return;
    record({ op: "move_footprint", args: { ref, x, y } });
  };
  $("ins-x")?.addEventListener("change", nudge);
  $("ins-y")?.addEventListener("change", nudge);

  for (const button of panel.querySelectorAll('[data-act="rot"]')) {
    button.addEventListener("click", () =>
      record({ op: "rotate_footprint", args: { ref, deg: Number(button.dataset.deg) } })
    );
  }
  for (const picker of panel.querySelectorAll(".net-pick")) {
    picker.addEventListener("change", () =>
      record({ op: "move_pin", args: { ref, pin: picker.dataset.pin, to_net: picker.value } })
    );
  }
  // A forty-eight pin part is a wall of selects, and the pin somebody wants is
  // never the one on screen. Filtering is local to the table and holds across a
  // re-render, because every edit re-renders and losing the filter each time
  // would make it useless for the case it exists for.
  const filter = $("ins-filter");
  const applyFilter = () => {
    const needle = filter.value.trim().toLowerCase();
    state.pinFilter = filter.value;
    for (const row of panel.querySelectorAll(".pins li")) {
      row.hidden = Boolean(needle) && !row.dataset.hay.includes(needle);
    }
  };
  filter.addEventListener("input", applyFilter);
  applyFilter();

  // A swap takes two clicks: arm one pin, then pick the one to exchange it
  // with. Two move_pins would leave both on one net in between, which is not
  // what a crossed connector looks like.
  for (const button of panel.querySelectorAll(".swap")) {
    button.addEventListener("click", () => {
      const pin = button.dataset.swap;
      if (state.armed && state.armed.ref === ref && state.armed.pin !== pin) {
        const pin_a = state.armed.pin;
        state.armed = null;
        record({ op: "swap_pins", args: { ref, pin_a, pin_b: pin } });
        return;
      }
      state.armed =
        state.armed && state.armed.ref === ref && state.armed.pin === pin
          ? null
          : { ref, pin };
      renderInspector();
    });
  }
  renderDatasheetPanel(panel, ref);
}

/** Two decimals, which is the precision a board file is drawn to. */
const mm2 = (n) => Number(n).toFixed(2);

/**
 * The package facts, as definition rows.
 *
 * Assembled as a string rather than through `html`, because that tag escapes
 * everything it interpolates - correctly, since the values are data - and a
 * nested template returning markup therefore arrived on screen as its own
 * source. Every value here is escaped on its way in instead.
 */
function packageRows(pk) {
  const rows = [
    ["Body", pk.body ? `${mm2(pk.body.w)} × ${mm2(pk.body.h)} mm` : "not drawn on this footprint"],
    ["Pads", `${pk.pads} ${pk.mount}${pk.pitch ? `, ${mm2(pk.pitch)} mm pitch` : ""}`],
  ];
  if (pk.drills.length) rows.push(["Drills", `${pk.drills.map(mm2).join(", ")} mm`]);
  return rows
    .map(([term, value]) => `<dt>${term}</dt><dd>${escapeHtml(value)}</dd>`)
    .join("");
}

/**
 * What a part is connected to, summarised.
 *
 * Every figure here is counted off this part's own pins. A rail it sits on, a
 * ground it does or does not reach, how many pins are driving and how many are
 * being driven, and how many go nowhere. None of it is a verdict: a part with
 * no ground pin is normal for a two-pin passive and alarming for an MCU, and
 * which one this is belongs to whoever is reading.
 */
/**
 * What to call a pin, for someone reading.
 *
 * A ground pin's electrical type in the symbol is `power_in`, which is true and
 * useless: VSSA is an analog ground, and labelling it POWER IN tells the reader
 * the opposite of what they need. The name decides, not the net - the name is a
 * property of the part, so it stays right when the part is miswired, and a
 * power pin sitting on a ground net keeps reading as a power pin, which is
 * exactly the case worth noticing.
 */
function pinRole(pin) {
  const role = baseType(pin.type || "");
  if (role === "power_in" && isGround(pin.function || pin.name || "")) return "ground";
  return role;
}

function electrics(pins) {
  const rails = new Set();
  const grounds = new Set();
  const roles = new Map();
  let floating = 0;
  for (const pin of pins) {
    const net = pin.net || "";
    if (isGround(net)) grounds.add(net.replace(/^\//, ""));
    else if (isRail(net)) rails.add(net.replace(/^\//, ""));
    if (/^unconnected-/.test(net)) floating += 1;
    const role = baseType(pin.type || "");
    if (role) roles.set(role, (roles.get(role) || 0) + 1);
  }
  return {
    rails: [...rails].sort(),
    grounds: [...grounds].sort(),
    roles: [...roles].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)),
    floating,
  };
}

function renderPadInspector(panel, sel) {
  const fp = state.board.layout.footprints.find((f) => f.ref === sel.ref);
  const pad = fp?.pads.find((p) => p.num === sel.pad);
  panel.innerHTML = `
    <div class="ins-head"><span class="ref">${escapeHtml(sel.ref)}.${escapeHtml(sel.pad)}</span>
      <span class="val">${escapeHtml(sel.net || "no net")}</span></div>
    <dl class="facts">
      ${pad ? html`<dt>Pad</dt><dd>${pad.w} × ${pad.h} mm ${pad.shape}, ${pad.layers.join(" ")}</dd>` : ""}
      ${pad?.function ? html`<dt>Pin name</dt><dd>${pad.function}</dd>` : ""}
      ${pad?.type ? html`<dt>Type</dt><dd>${pad.type}</dd>` : ""}
    </dl>
    <button class="btn" data-act="part">Open ${escapeHtml(sel.ref)}</button>
  `;
  panel.querySelector('[data-act="part"]').addEventListener("click", () =>
    select({ kind: "part", ref: sel.ref })
  );
}

function renderTrackInspector(panel, id) {
  const track = state.board.layout.tracks.find((t) => t.id === id);
  if (!track) return;
  const length = Math.hypot(track.x2 - track.x1, track.y2 - track.y1);
  panel.innerHTML = `
    <div class="ins-head"><span class="ref">Track</span>
      <span class="val">${escapeHtml(track.net || "no net")}</span></div>
    <dl class="facts">
      <dt>Layer</dt><dd>${escapeHtml(track.layer)}</dd>
      <dt>Length</dt><dd>${length.toFixed(2)} mm</dd>
      <dt>Carries</dt><dd>about ${(track.width / 0.5).toFixed(1)} A at a 20 °C rise</dd>
    </dl>
    <label class="field">
      <span>Width, mm</span>
      <input id="ins-width" type="number" min="0.05" max="5" step="0.05" value="${track.width}">
    </label>
    <button class="btn danger" data-act="del">Delete this track</button>
  `;
  $("ins-width").addEventListener("change", (event) => {
    const mm = Number(event.target.value);
    if (mm === track.width) return;
    // 0.1 mm is about the finest a cheap fabricator will quote, and 5 mm is
    // wider than this board. Silently accepting 999 was worse than refusing it.
    if (!(mm >= 0.1 && mm <= 5)) {
      flash(`A track is between 0.1 and 5 mm. ${event.target.value} is not.`);
      event.target.value = track.width;
      return;
    }
    record({ op: "set_track_width", args: { track_id: id, mm } });
  });
  panel.querySelector('[data-act="del"]').addEventListener("click", () => {
    record({ op: "delete_track", args: { track_id: id } });
    select(null);
  });
}

function renderViaInspector(panel, id) {
  const via = state.board.layout.vias.find((v) => v.id === id);
  if (!via) return;
  panel.innerHTML = `
    <div class="ins-head"><span class="ref">Via</span>
      <span class="val">${escapeHtml(via.net || "no net")}</span></div>
    <dl class="facts">
      <dt>At</dt><dd>${via.x.toFixed(2)}, ${via.y.toFixed(2)} mm</dd>
      <dt>Size</dt><dd>${via.size} mm pad, ${via.drill} mm drill</dd>
      <dt>Spans</dt><dd>${escapeHtml((via.layers || []).join(" to "))}</dd>
    </dl>
    <button class="btn danger" data-act="del">Delete this via</button>
  `;
  panel.querySelector('[data-act="del"]').addEventListener("click", () => {
    record({ op: "delete_via", args: { via_id: id } });
    select(null);
  });
}

function renderZoneInspector(panel, id) {
  const zone = state.board.layout.zones.find((z) => z.id === id);
  if (!zone) return;
  panel.innerHTML = `
    <div class="ins-head"><span class="ref">Pour</span>
      <span class="val">${escapeHtml(zone.net || "no net")}</span></div>
    <dl class="facts">
      <dt>Layer</dt><dd>${escapeHtml(zone.layer)}</dd>
      <dt>State</dt><dd>${zone.disabled ? "removed" : "filled"}</dd>
    </dl>
    <button class="btn ${zone.disabled ? "" : "danger"}" data-act="toggle">
      ${zone.disabled ? "Restore this pour" : "Remove this pour"}
    </button>
  `;
  panel.querySelector('[data-act="toggle"]').addEventListener("click", () =>
    record({ op: "toggle_zone", args: { zone_id: id } })
  );
}

// --------------------------------------------------------------------- panels


function renderLog() {
  const list = $("log");
  $("log-count").textContent = state.log.length ? String(state.log.length) : "none";
  $("undo").disabled = !state.log.length;
  $("reset").disabled = !state.log.length;
  if (!state.log.length) {
    list.innerHTML = `<li class="muted">Nothing changed yet.</li>`;
    return;
  }
  const shown = state.log.slice(-8).reverse();
  list.innerHTML =
    (state.log.length > 8
      ? `<li class="muted">${state.log.length - 8} earlier edits</li>`
      : "") + shown.map((entry) => html`<li>${entry.label}</li>`).join("");
}

function flash(message) {
  const note = $("flash");
  note.textContent = message;
  note.classList.add("on");
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => note.classList.remove("on"), 3200);
}

// --------------------------------------------------------------------- review

/** What the visitor changed, so a finding can be matched against it. */
function expectedFromState() {
  return state.log.map((entry, i) => {
    const args = entry.args || {};
    const refs = [args.ref].filter(Boolean);
    const nets = [args.to_net, entry.from_net, entry.track?.net, entry.via?.net].filter(Boolean);
    if (entry.op === "swap_pins") nets.push(...netsOf(args.ref));
    return { id: `edit-${i}`, title: entry.label, refs, nets };
  });
}

async function runReview() {
  if (state.reviewing) return;
  state.reviewing = true;
  state.reviewError = null;
  state.focused = null;
  state.steps = [];
  // Go to the review tab first. The button is at the bottom of a long rail and
  // the stage is what anyone is actually watching, so that is where the state
  // change has to happen.
  setView("review");
  renderReview();
  try {
    state.steps = [];
    const result = await review(state.sample, state.board, {
      onStep: (step, steps) => {
        state.steps = steps.slice();
        renderOverlay();
      },
    });
    state.steps = result.steps || state.steps;
    state.verdict = result;
    paintMarks();
  } catch (error) {
    // Every outcome is rendered in the panel next to the button. It used to be
    // flashed over the board instead, which is a different scroll region and
    // often off screen entirely — so a refused review looked like a dead
    // button. And `not_granted` used to hide the button, which looked like the
    // page had eaten it.
    state.verdict = null;
    state.reviewError = {
      code: error?.code || "upstream_error",
      message: reviewCopy(error),
    };
  } finally {
    state.reviewing = false;
    renderReview();
    renderOverlay();
    // Open the first finding, so the answer to "what did it say" is already on
    // the board rather than one click away.
    if (state.verdict?.findings?.length) focusFinding(0);
  }
}

/** What to tell the person who pressed the button, per error code. */
function reviewCopy(error) {
  const code = error?.code;
  if (code === "cooldown" || code === "capped" || code === "unavailable") return error.message;
  if (code === "not_granted")
    return `The first review asks your permission to use Claude, and this view has
      not given it. Reload the page and choose Allow, or open it inside Claude.`;
  if (code === "sampling_disabled")
    return "The review service is not reachable right now.";
  if (code === "not_declared" || code === "capability_disabled")
    return "This copy of the page cannot reach Claude. Everything else still works.";
  if (code === "rate_limited")
    return "Claude is rate limiting this account. Give it a minute and press again.";
  if (code === "session_expired") return "Your Claude session expired. Sign in again, then review.";
  if (code === "invalid_json")
    return "The reply was not valid JSON. Press review again — this one is usually transient.";
  if (code === "empty_completion")
    return "Claude returned nothing at all. Try again, or undo an edit and review a simpler board.";
  if (code === "prompt_too_large")
    return "The board came out too large to send. Undo an edit and try again.";
  if (code === "cancelled") return "The review was stopped before it finished.";
  return error?.message || "The review did not finish. Press it again.";
}

/** Errors you can do something about; the rest leave the button disabled. */
const RETRYABLE = new Set([
  "cooldown",
  "rate_limited",
  "invalid_json",
  "empty_completion",
  "upstream_error",
  "cancelled",
]);

/** Show one finding: its view, its parts ringed, its nets lit, its part opened. */
function focusFinding(index) {
  const finding = state.verdict?.findings?.[index];
  if (!finding) return;
  state.focused = index;

  const svg = currentSvg();
  if (svg) {
    clearMarks(svg);
    markDivergence(svg, state.board);
    markRefs(svg, state.board, finding.refs, "flag");
    highlightNets(svg, finding.nets);
  }

  // Open the first part it names, so the inspector explains what the finding is
  // talking about rather than leaving a ring with no context.
  const ref = finding.refs.find((r) =>
    state.board.components.some((c) => c.ref === r)
  );
  if (ref) {
    state.selection = { kind: "part", ref };
    renderInspector();
    if (svg) {
      for (const node of svg.querySelectorAll(`[data-ref="${cssEscape(ref)}"]`)) {
        node.classList.add("selected");
      }
    }
  }
  renderReview();
}

/** The graph, as a list of steps with what each one did. */
function pipelineHtml(steps) {
  if (!steps.length) return `<p class="ro-empty muted">Starting.</p>`;
  return steps
    .map((step) => {
      const measured = MEASURED.has(step.node) || step.measured;
      const body = step.running
        ? `<pre class="ro-stream">${escapeHtml(step.stream || "")}</pre>`
        : stepSummary(step);
      return `<div class="ro-step ${measured ? "measured" : "model"}${
        step.running ? " running" : ""
      }${step.decision === "again" ? " looping" : ""}">
        <div class="ro-step-head">
          ${step.running ? '<span class="ro-dot"></span>' : ""}
          <b>${escapeHtml(step.node)}</b>
          ${step.pass ? `<span class="ro-pass">pass ${step.pass}</span>` : ""}
          ${measured ? '<span class="ro-tag">measured</span>' : ""}
        </div>
        <span class="ro-role">${escapeHtml(ROLES[step.node] || "")}</span>
        ${body}
      </div>`;
    })
    .join("");
}

function stepSummary(step) {
  if (step.node === "ingest") {
    return `<span class="ro-said">${escapeHtml(step.summary || "")}</span>` +
      (step.rules || [])
        .map((r) => html`<span class="ro-rule">${r.title}</span>`)
        .join("");
  }
  if (step.node === "gate") {
    return `<span class="ro-said"><code>${escapeHtml(step.decision)}</code></span>
      <span class="ro-role">${escapeHtml(step.why || "")}</span>`;
  }
  if (step.node === "adjudicate") {
    const dropped = (step.dropped || [])
      .map((d) => html`<span class="ro-rule dropped">${d.title} — ${d.dropped}</span>`)
      .join("");
    return `<span class="ro-said">Merged ${step.merged ?? 0} into ${
      (step.confirmed || []).length
    }${(step.dropped || []).length ? `, and the board threw out ${step.dropped.length}` : ""}.</span>${dropped}`;
  }
  const found = (step.found || []).length;
  return `<span class="ro-said">Proposed ${found} finding${found === 1 ? "" : "s"}.</span>` +
    (step.found || []).map((f) => html`<span class="ro-rule">${f.title}</span>`).join("");
}

/**
 * The report over the board, and the state of the Review tab.
 *
 * This exists because the review used to happen entirely inside a panel at the
 * bottom of a scrolling rail: pressing the button changed nothing anywhere the
 * person pressing it was looking. Now the stage takes it — the board stays
 * underneath, in whichever view the finding belongs in, with the finding
 * explained beside it.
 */
function renderOverlay() {
  const overlay = $("review-overlay");
  const tab = $("tab-review");
  const findings = state.verdict?.findings || [];

  tab.dataset.state = state.reviewing ? "running" : findings.length ? "done" : "none";
  tab.dataset.count = String(findings.length);

  if (state.view !== "review") {
    overlay.hidden = true;
    return;
  }
  overlay.hidden = false;

  if (state.reviewing) {
    overlay.innerHTML = `
      <div class="ro-head"><h3>Reviewing</h3></div>
      <div class="ro-list">${pipelineHtml(state.steps)}</div>
      <div class="ro-foot">Three reviewers, then a merge the board can overrule.
        The gate decides whether that was enough.</div>`;
    return;
  }

  if (state.reviewError) {
    overlay.innerHTML = `
      <div class="ro-head"><h3>Review</h3></div>
      <div class="ro-empty">
        <p><b style="color:var(--crit);font-family:var(--mono);font-size:11px">
          ${escapeHtml(state.reviewError.code)}</b></p>
        <p>${escapeHtml(state.reviewError.message)}</p>
        ${RETRYABLE.has(state.reviewError.code)
          ? `<button class="primary" id="ro-go">Try again</button>`
          : ""}
      </div>`;
    overlay.querySelector("#ro-go")?.addEventListener("click", runReview);
    return;
  }

  if (!findings.length) {
    overlay.innerHTML = `
      <div class="ro-head"><h3>Review</h3></div>
      <div class="ro-empty">
        <p>${state.verdict
          ? "It reported nothing. On an untouched board that is the right answer."
          : "Nothing has been reviewed yet."}</p>
        ${state.sample
          ? `<button class="primary" id="ro-go">Review this board</button>`
          : `<p class="hint">The review service is not reachable from here. Everything else on the page works.</p>`}
      </div>`;
    overlay.querySelector("#ro-go")?.addEventListener("click", runReview);
    return;
  }

  const { caught, missed, other } = grade(findings, expectedFromState());
  const total = caught.length + missed.length;
  const verdict = state.verdict;
  overlay.innerHTML = `
    <div class="ro-head">
      <h3>${findings.length} finding${findings.length === 1 ? "" : "s"}${
        verdict.cached ? " · from cache" : ""
      }</h3>
      <div class="ro-score">
        <div class="${caught.length ? "good" : ""}"><b>${caught.length}</b>
          <span>caught${total ? ` of ${total}` : ""}</span></div>
        <div class="${missed.length ? "bad" : ""}"><b>${missed.length}</b><span>missed</span></div>
        <div class="${other.length ? "warn" : ""}"><b>${other.length}</b><span>also raised</span></div>
      </div>
    </div>
    <div class="ro-list">${findings
      .map(
        (finding, i) => `<button class="ro-item sev-${escapeHtml(finding.severity)}${
          state.focused === i ? " on" : ""
        }" data-finding="${i}">
          ${bullet("Problem", finding.title)}
          ${bullet("Why", finding.why)}
          ${bullet("Solution", finding.fix)}
          <span class="tags">${[...finding.refs, ...finding.nets]
            .map((tag) => html`<code>${tag}</code>`)
            .join("")}</span>
        </button>`
      )
      .join("")}</div>
    <details class="ro-graph">
      <summary>How it got there — ${verdict.passes} pass${
        verdict.passes === 1 ? "" : "es"
      }, ${verdict.proposed} proposed, ${findings.length} reported</summary>
      ${pipelineHtml(verdict.steps || [])}
    </details>
    <div class="ro-foot">Click a finding to put it on the board.</div>`;

  for (const button of overlay.querySelectorAll(".ro-item")) {
    button.addEventListener("click", () => focusFinding(Number(button.dataset.finding)));
  }
}

/** Which parts the visitor has touched, so an edit is visible on the board. */
function editedRefs() {
  const refs = new Set();
  for (const entry of state.log) {
    if (entry.args?.ref) refs.add(entry.args.ref);
    if (entry.track?.net || entry.via?.net) continue;
  }
  return [...refs];
}

/**
 * Everything drawn over the board: what was edited, what the board now
 * disagrees with itself about, and what a review flagged.
 *
 * The middle one is the point. A schematic edit changes the net list and
 * nothing else, so on its own it would be invisible — the picture cannot
 * change and the copper is not touched. What it does produce is a
 * disagreement, and that is drawable: the pad is ringed and a ratsnest line
 * runs to the pin the design now says it joins.
 */
function paintMarks() {
  const svg = currentSvg();
  if (!svg) return;
  clearMarks(svg);

  let found = { stale: [], stranded: [] };
  found = markDivergence(svg, state.board);
  state.divergence = found;

  markRefs(svg, state.board, editedRefs(), "edit");
  if (state.verdict) {
    const focused = state.verdict.findings[state.focused];
    const refs = focused
      ? focused.refs
      : state.verdict.findings.flatMap((f) => f.refs);
    markRefs(svg, state.board, refs, "flag");
    if (focused) highlightNets(svg, focused.nets);
  }
  renderDivergenceNote();
}

function renderDivergenceNote() {
  const note = $("divergence");
  const { stale, stranded } = state.divergence || { stale: [], stranded: [] };
  if (!stale.length && !stranded.length) {
    note.hidden = true;
    return;
  }
  note.hidden = false;
  const parts = [];
  if (stale.length) {
    parts.push(
      `<b>${stale.length}</b> pad${stale.length === 1 ? "" : "s"} now sit${stale.length === 1 ? "s" : ""} on copper
       laid for a different net. The dashed line runs to the pin the schematic says it joins now.`
    );
  }
  if (stranded.length) {
    parts.push(
      `<b>${stranded.length}</b> pad${stranded.length === 1 ? " is" : "s are"} stranded on copper
       that does not reach the rest of ${[...new Set(stranded.map((s) => s.net))].join(", ")}.`
    );
  }
  note.innerHTML = parts.join(" ");
}

function renderReview() {
  const panel = $("review");
  const stream = $("review-stream");
  const button = $("go");

  if (!state.sample) {
    // Only the review needs Claude. Say which part, and say it without
    // implying the page is broken — everything that makes the board is here.
    panel.innerHTML = `<p class="muted">The review service is not reachable from here. Everything else works.</p>`;
    button.hidden = true;
    stream.hidden = true;
    return;
  }
  button.hidden = false;
  button.disabled = state.reviewing;
  button.textContent = state.reviewing ? "Reviewing…" : "Review this board";
  stream.hidden = !state.reviewing;
  if (!state.reviewing) stream.textContent = "";

  $("budget").textContent = "";

  if (state.reviewing) {
    panel.innerHTML = `<p class="muted">Sending the board as it stands now.</p>`;
    return;
  }

  // An error goes here, next to the button that caused it, and stays until the
  // next attempt. Anything that cannot be retried also disables the button, so
  // it is obvious that pressing again will not help.
  if (state.reviewError) {
    const { code, message } = state.reviewError;
    const canRetry = RETRYABLE.has(code);
    button.disabled = !canRetry;
    panel.innerHTML = `
      <div class="review-error">
        <span class="review-error-code">${escapeHtml(code)}</span>
        <p>${escapeHtml(message)}</p>
      </div>
      <p class="hint">Nothing else on the page depends on it.</p>`;
    return;
  }

  if (!state.verdict) {
    const counts = islandCounts(state.board);
    const broken = [...counts.entries()].filter(([, n]) => n > 1);
    panel.innerHTML = state.log.length
      ? `<p class="muted">${state.log.length} edit${state.log.length === 1 ? "" : "s"} pending.${
          broken.length
            ? ` The copper disagrees with the net list on ${broken.length} net${
                broken.length === 1 ? "" : "s"
              }.`
            : ""
        }</p>`
      : "";
    return;
  }

  const { caught, missed, other } = grade(state.verdict.findings, expectedFromState());
  const total = caught.length + missed.length;
  panel.innerHTML = `
    <div class="score">
      <div class="score-cell ${caught.length ? "good" : ""}">
        <b>${caught.length}</b><span>caught${total ? ` of ${total}` : ""}</span></div>
      <div class="score-cell ${missed.length ? "bad" : ""}">
        <b>${missed.length}</b><span>missed</span></div>
      <div class="score-cell ${other.length ? "warn" : ""}">
        <b>${other.length}</b><span>also raised</span></div>
    </div>
    ${state.verdict.cached ? `<p class="cached">Replayed from this browser's cache — no call was made.</p>` : ""}
    ${missed.length ? `<h4 class="eyebrow">Missed</h4><ul class="findings">${missed
      .map((want) => html`<li class="missed"><b>${want.title}</b></li>`)
      .join("")}</ul>` : ""}
    ${state.verdict.findings.length
      ? `<h4 class="eyebrow">What it reported — click one to see it on the board</h4>
         <ul class="findings">${state.verdict.findings
          .map(
            (finding, i) => `<li class="sev-${escapeHtml(finding.severity)}${
              state.focused === i ? " focused" : ""
            }">
              <button class="finding" data-finding="${i}">
                ${bullet("Problem", finding.title)}
                ${bullet("Why", finding.why)}
                ${bullet("Solution", finding.fix)}
              </button>
            </li>`
          )
          .join("")}</ul>`
      : `<p class="muted">No findings. On the untouched board that is the right
         answer; after an edit it is a miss.</p>`}
  `;

  for (const button of panel.querySelectorAll(".finding")) {
    button.addEventListener("click", () => focusFinding(Number(button.dataset.finding)));
  }
}

// ----------------------------------------------------------------------- shell

function setView(view) {
  state.view = view;
  for (const tab of document.querySelectorAll(".tab")) {
    tab.classList.toggle("on", tab.dataset.view === view);
    tab.setAttribute("aria-selected", String(tab.dataset.view === view));
  }
  keptView = null;
  drawView({ keepZoom: false });
  renderOverlay();
}

function boot() {
  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => setView(tab.dataset.view));
  }
  for (const chip of document.querySelectorAll(".chip")) {
    chip.addEventListener("click", () => {
      chip.classList.toggle("off");
      const svg = currentSvg();
      if (svg) svg.classList.toggle(`hide-${chip.dataset.layer}`, chip.classList.contains("off"));
    });
  }
  attachUpload({
    input: $("file-input"),
    dropZone: $("stage"),
    onBoard: (board, notes, files) => loadBoard(board, notes, files),
    onError: (message) => {
      $("source").innerHTML = html`<p class="load-error">${message}</p>`;
      $("source").innerHTML += `<p class="hint">Drop the folder that holds the
        .kicad_pcb and .kicad_sch, or pick the two files.</p>`;
    },
    onBusy: (busy) => {
      $("stage").classList.toggle("loading", busy);
    },
  });

  // Keyboard, for the two things done often enough to be worth a key.
  // Ignored while typing, or every value field would rotate the part.
  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Escape") {
      if (document.querySelector(".modal-back")) return;
      state.armed = null;
      select(null);
    } else if ((e.key === "r" || e.key === "R") && state.selection?.kind === "part") {
      // A quarter turn from wherever it is now. The operation takes an absolute
      // angle, so pressing R three times used to set 90 degrees three times -
      // the second and third threw "already at 90" and the part never moved.
      const fp = state.board.layout.footprints.find((f) => f.ref === state.selection.ref);
      if (fp) {
        record({ op: "rotate_footprint", args: { ref: fp.ref, deg: (Number(fp.rot) + 90) % 360 } });
      }
    } else {
      return;
    }
    e.preventDefault();
  });

  $("undo").addEventListener("click", undoLast);
  $("reset").addEventListener("click", resetBoard);
  $("go").addEventListener("click", runReview);
  $("fit").addEventListener("click", () => panzoom?.reset());
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "z") {
      event.preventDefault();
      undoLast();
    }
    if (event.key === "Escape") select(null);
  });

  renderSource();
  setView("routing");
  renderLog();
  renderInspector();
  renderReview();

  // Never on load. `sample` prompts the viewer for consent on the first call,
  // so resolving the capability is all that happens here.
  getSample().then((sample) => {
    state.sample = sample;
    renderReview();
  });
  // The countdown, and only the countdown. It used to re-enable the button half
  // a second after an error disabled it, and overwrite the label with it.
  setInterval(() => {
    if (state.reviewing || !state.sample || state.reviewError) return;
    const left = coolingDownMs();
    const go = $("go");
    if (left > 0) {
      go.textContent = `Review in ${Math.ceil(left / 1000)}s`;
      go.disabled = true;
    } else if (go.disabled) {
      go.disabled = false;
      go.textContent = "Review this board";
    }
  }, 500);
}

boot();


/**
 * What the review knows about this part's documentation, in one line.
 *
 * The detail lives in a dialog rather than in the rail. The rail is 300 pixels
 * of a column that already holds four panels, and attaching a document means
 * reading what came back out of it - which needs room the rail does not have.
 */
function renderDatasheetPanel(panel, ref) {
  const state_ = coverage(state.board).get(ref);
  if (!state_) return;

  const doc = state_.doc;
  const wrap = document.createElement("div");
  wrap.className = `ds-panel ${state_.status}`;
  wrap.innerHTML = `
    <h4>Documentation</h4>
    ${doc ? html`<p class="ds-why">${doc.name} · ${plural(doc.pages.length, "page")}</p>` : ""}
    <div class="row"><button class="btn" id="ds-open">${
      doc ? "Replace" : "Attach a PDF"
    }</button></div>`;
  panel.appendChild(wrap);
  wrap.querySelector("#ds-open").addEventListener("click", () => openDocs(ref));
}

/** Repaint the badges from whatever is stored now. */
function paintDatasheets() {
  const svg = document.querySelector("#stage .board-svg");
  if (svg) markDatasheets(svg, state.board, coverage(state.board));
}

/** "1 page", "3 pages". Written once because it appears in three places. */
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The documentation dialog for one part. Attach a PDF, or take one away.
 *
 * It used to take typed parameters and pasted text as well, and to print the
 * passages retrieval would return. The passages were the interesting half of
 * that and still the wrong thing to put here - they are the retrieval's own
 * debug output, and a BM25 score tells nobody anything they can act on. What
 * they did earn was a fix: a table of contents was scoring third on an MCU,
 * because it names every section in the document and so matches any query built
 * out of section names. Contents pages are no longer indexed at all.
 */
function openDocs(ref) {
  const name = state.board.meta.name;
  const host = document.createElement("div");
  host.className = "modal-back";
  host.innerHTML = `<div class="modal" role="dialog" aria-modal="true"
      aria-label="Documentation for ${escapeHtml(ref)}">
    <div class="modal-head">
      <h3>Documentation <em>${escapeHtml(ref)}</em></h3>
      <button class="icon" id="dm-close" aria-label="Close">&times;</button>
    </div>
    <div class="modal-body" id="dm-body"></div>
  </div>`;
  document.body.appendChild(host);

  const close = () => {
    host.remove();
    document.removeEventListener("keydown", onKey);
    paintDatasheets();
    renderInspector();
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);
  host.addEventListener("click", (e) => {
    if (e.target === host) close();
  });
  host.querySelector("#dm-close").addEventListener("click", close);

  const body = host.querySelector("#dm-body");
  paint();

  function paint() {
    const doc = docFor(name, ref);
    body.innerHTML = doc
      ? html`<div class="dm-file"
          ><span class="dm-name">${doc.name}</span
          ><span class="dm-meta">${plural(doc.pages.length, "page")}</span
          ><button class="btn danger" id="dm-remove">Remove</button></div>` + readOut(name, ref)
      : `<label class="dm-drop" id="dm-drop">
          <input type="file" id="dm-file" accept=".pdf,application/pdf">
          <b>Drop a PDF</b>
          <span>or click to choose</span>
        </label>`;

    body.querySelector("#dm-remove")?.addEventListener("click", async () => {
      await detach(name, ref);
      paint();
    });
    body.querySelector("#dm-file")?.addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      if (file) take(file);
    });
    const drop = body.querySelector("#dm-drop");
    if (drop) {
      drop.addEventListener("dragover", (e) => {
        e.preventDefault();
        drop.classList.add("over");
      });
      drop.addEventListener("dragleave", () => drop.classList.remove("over"));
      drop.addEventListener("drop", (e) => {
        e.preventDefault();
        drop.classList.remove("over");
        const file = e.dataTransfer?.files?.[0];
        if (file) take(file);
      });
    }
  }

  /**
   * What the patterns found in this part's document.
   *
   * A page number against every value, because a parameter with no page is a
   * parameter nobody can check, and checking is the entire reason a document
   * beats a number somebody typed. A reading the extractor is unsure of is
   * shown and marked rather than hidden: a thermal table puts one row across
   * four package columns, and a pattern that takes a number out of such a row
   * has picked a column, not read a value. Those are the readings most worth
   * a human glance, so they are the last ones to hide.
   */
  function readOut(boardName, part) {
    const facts = factsOf(boardName, part);
    const found = Object.entries(facts);
    if (!found.length) {
      return `<p class="dm-none">No known parameters in this document.
        Its text is still searched when the board is reviewed.</p>`;
    }
    return (
      '<ul class="dm-facts">' +
      found
        .map(
          ([, f]) => html`<li class="${f.confidence === "low" ? "unsure" : ""}"
            ><span class="dm-label">${f.label}</span
            ><span class="dm-value">${f.shown}</span
            ><span class="dm-page">p${f.page}${
            f.confidence === "low" ? " · unsure" : ""
          }</span><span class="dm-quote">${f.quote}</span></li>`
        )
        .join("") +
      "</ul>"
    );
  }

  /**
   * Read the PDF and close.
   *
   * Nothing is said on success. The dialog closing and the badge changing are
   * the confirmation, and a message on top of those is a third way of saying
   * what has already been said twice. A failure still speaks, because nothing
   * else on screen would explain it.
   */
  async function take(file) {
    try {
      const pages = await pagesOfPdf(file);
      if (!pages.join(" ").trim()) {
        return flash("No text in that PDF. A scanned one has none to read.");
      }
      await attach(name, ref, { name: file.name, pages });
      close();
    } catch (err) {
      flash(err.message);
    }
  }
}
