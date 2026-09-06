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
  renderBoard,
  renderSchematic,
} from "./render.js";
import { islandCounts } from "./copper.js";
import { summarise } from "./kicad.js";
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
  SESSION_CAP,
} from "./review.js";

const $ = (id) => document.getElementById(id);
const clone = (value) => JSON.parse(JSON.stringify(value));

const SAMPLE = JSON.parse($("board-data").textContent);
const PRESETS = JSON.parse($("preset-data").textContent);

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
  //: Which board view the review tab is showing underneath its report.
  reviewSub: "routing",
  reviewing: false,
  presetId: null,
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

  // In review mode the board is still the board; the report sits over it. Which
  // view it shows is decided by the finding being read.
  const showing = state.view === "review" ? state.reviewSub : state.view;
  // The embedded plot belongs to the sample board and only to it. Handing it to
  // a loaded board would draw somebody else's schematic over their parts.
  const sheet = custom ? null : $("sheet-svg").content.cloneNode(true);
  const svg =
    showing === "schematic"
      ? renderSchematic(state.board, sheet)
      : renderBoard(state.board, { copper: showing === "routing" });
  svg.dataset.view = showing;
  stage.appendChild(svg);

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
  if (state.view === "schematic") return false;
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

function record(edit) {
  try {
    state.log.push(applyEdit(state.board, edit));
  } catch (error) {
    flash(error.message);
    return false;
  }
  state.presetId = null;
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
  renderPresets();
}

function undoLast() {
  if (!state.log.length) return;
  undo(state.board, state.log);
  state.presetId = null;
  state.verdict = null;
  afterChange();
}

function resetBoard() {
  state.board = clone(ORIGINAL);
  state.log = [];
  state.presetId = null;
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
  state.presetId = null;
  state.verdict = null;
  state.reviewError = null;
  state.focused = null;
  state.selection = null;
  keptView = null;

  const hasPlot = !custom;
  $("tab-schematic").dataset.plot = hasPlot ? "yes" : "no";
  setView(custom ? "routing" : state.view);
  renderSource();
  afterChange();
}

function renderSource() {
  const panel = $("source");
  const stats = state.board.layout;
  $("board-id").textContent = custom
    ? `${custom.name} · your file`
    : "stm32-good · pillmate rev 1";

  if (!custom) {
    panel.innerHTML = `<p class="muted">Reviewing the sample board — a real
      STM32 controller, with the seven defects below to try. Load a KiCad
      project to review your own instead.</p>`;
  } else {
    panel.innerHTML = `
      <p class="loaded"><b>${escapeHtml(custom.name)}</b> ${escapeHtml(summarise(state.board))}</p>
      ${custom.notes.map((n) => html`<p class="hint">${n}</p>`).join("")}
      <button class="btn" id="unload">Back to the sample board</button>`;
    panel.querySelector("#unload").addEventListener("click", () => loadBoard(null));
  }
  $("presets-panel").hidden = Boolean(custom);
}

function applyPreset(preset) {
  resetBoard();
  for (const edit of preset.edits) {
    try {
      state.log.push(applyEdit(state.board, edit));
    } catch (error) {
      flash(`${preset.id}: ${error.message}`);
      break;
    }
  }
  state.presetId = preset.id;
  state.view = preset.view === "schematic" ? "schematic" : "routing";
  setView(state.view);
  select(preset.refs?.length ? { kind: "part", ref: preset.refs[0] } : null);
  afterChange();
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
    panel.innerHTML = `<p class="muted">Click a part, a track, a via or a pour.
      Drag a part to move it. Everything you change is listed under Edits.</p>`;
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

  panel.innerHTML = `
    <div class="ins-head">
      <span class="ref">${escapeHtml(ref)}</span>
      <span class="val">${escapeHtml(comp.value)}</span>
    </div>
    ${comp.description ? html`<p class="desc">${comp.description}</p>` : ""}
    <dl class="facts">
      <dt>Package</dt><dd>${escapeHtml((comp.footprint || "").split(":").pop())}</dd>
      ${fp ? html`<dt>Placed</dt><dd>${fp.x.toFixed(2)}, ${fp.y.toFixed(2)} mm · ${Number(fp.rot)}° · ${fp.layer}.Cu</dd>` : ""}
      ${fp && fp.silk !== ref ? html`<dt>Silkscreen</dt><dd>${fp.silk}</dd>` : ""}
    </dl>

    <label class="field">
      <span>Value</span>
      <input id="ins-value" type="text" value="${escapeHtml(comp.value)}" spellcheck="false">
    </label>

    ${fp ? `<div class="row">
      <button class="btn" data-act="rot" data-deg="90">Rotate 90°</button>
      <button class="btn" data-act="rot" data-deg="180">180°</button>
      <button class="btn" data-act="rot" data-deg="270">270°</button>
    </div>` : ""}

    <h4 class="eyebrow">Pins</h4>
    <table class="pins">
      <tbody>
        ${pins
          .map((pin) => {
            const armed = state.armed && state.armed.ref === ref && state.armed.pin === pin.pin;
            return `<tr>
              <th>${escapeHtml(pin.pin)}</th>
              <td class="fn">${escapeHtml(pin.function || "")}</td>
              <td>
                <select class="net-pick" data-pin="${escapeHtml(pin.pin)}">
                  ${netNames
                    .map(
                      (name) =>
                        `<option value="${escapeHtml(name)}"${name === pin.net ? " selected" : ""}>${escapeHtml(name)}</option>`
                    )
                    .join("")}
                </select>
              </td>
              <td><button class="swap${armed ? " armed" : ""}" data-swap="${escapeHtml(pin.pin)}"
                title="Swap this pin with another">&#8646;</button></td>
            </tr>`;
          })
          .join("")}
      </tbody>
    </table>
    ${state.armed && state.armed.ref === ref
      ? html`<p class="hint armed-hint">Pin ${state.armed.pin} is armed. Pick the pin to swap it with.</p>`
      : `<p class="hint">The ⇆ buttons swap two pins in one move, which is how a
         connector gets wired the wrong way round.</p>`}
    <p class="hint">Changing a net here edits the schematic only. The copper keeps
      the routing it was laid out with, which is what a board looks like after a
      change nobody re-routed.</p>
  `;

  const value = $("ins-value");
  value.addEventListener("change", () => {
    if (value.value !== comp.value) record({ op: "set_value", args: { ref, value: value.value } });
  });
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

function renderPresets() {
  $("presets").innerHTML = PRESETS.map(
    (preset) => `<button class="preset${state.presetId === preset.id ? " on" : ""}"
        data-id="${escapeHtml(preset.id)}">
        <span class="preset-title">${escapeHtml(preset.title)}</span>
        <span class="preset-why">${escapeHtml(preset.breaks)}</span>
      </button>`
  ).join("");
  for (const button of $("presets").querySelectorAll(".preset")) {
    button.addEventListener("click", () =>
      applyPreset(PRESETS.find((p) => p.id === button.dataset.id))
    );
  }
}

function renderLog() {
  const list = $("log");
  $("log-count").textContent = state.log.length ? String(state.log.length) : "none";
  $("undo").disabled = !state.log.length;
  $("reset").disabled = !state.log.length;
  if (!state.log.length) {
    list.innerHTML = `<li class="muted">The board is as it was manufactured.</li>`;
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

function expectedFromState() {
  if (state.presetId) {
    const preset = PRESETS.find((p) => p.id === state.presetId);
    return [{ id: preset.id, title: preset.title, refs: preset.refs, nets: preset.nets }];
  }
  // A hand-made edit is graded the same way: what did it touch?
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
  // Go to the review tab first. The button is at the bottom of a long rail and
  // the stage is what anyone is actually watching, so that is where the state
  // change has to happen.
  setView("review");
  renderReview();
  try {
    const result = await review(state.sample, state.board, {
      onText: (update) => {
        $("review-stream").textContent = update.text.slice(-600);
        const status = $("ro-status");
        if (status) status.textContent = "Reading the reply";
        const stream = $("ro-stream");
        if (stream) stream.textContent = update.text.slice(-420);
      },
    });
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
    return "Claude is not available on this account, so the review cannot run here.";
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

/**
 * Which view a finding is best read in.
 *
 * A claim about copper — islands, vias, pours, trace width — can only be seen
 * in the routing view. A claim about a pin, a value or a connector's order is a
 * schematic claim. Everything else goes to routing, because that is where the
 * board is most itself.
 */
const COPPER_CLAIM =
  /island|via|pour|trace width|copper|stranded|thermal|clearance|stitch|plane|layer|routing|track/i;
const SCHEMATIC_CLAIM =
  /pin|net list|netlist|value|pull-?up|pull-?down|float|connector|pinout|swapped|wired|footprint|bom/i;

function viewForFinding(finding) {
  const text = `${finding.title} ${finding.why}`;
  if (COPPER_CLAIM.test(text)) return "routing";
  if (SCHEMATIC_CLAIM.test(text)) return "schematic";
  return "routing";
}

/** Show one finding: its view, its parts ringed, its nets lit, its part opened. */
function focusFinding(index) {
  const finding = state.verdict?.findings?.[index];
  if (!finding) return;
  state.focused = index;

  const wanted = viewForFinding(finding);
  if (state.view === "review") {
    if (state.reviewSub !== wanted) {
      state.reviewSub = wanted;
      setView("review");
    }
  } else if (wanted !== state.view) {
    setView(wanted);
  }

  const svg = currentSvg();
  if (svg) {
    clearMarks(svg);
    if (svg.dataset.view !== "schematic") markDivergence(svg, state.board);
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
      <div class="ro-head"><h3>Reviewing</h3>
        <div class="ro-running"><span class="ro-dot"></span><span id="ro-status">Sending the board</span></div>
        <pre class="ro-stream" id="ro-stream"></pre>
      </div>`;
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
          : "Nothing has been reviewed yet. Break something first, or review the board as it is — a reviewer that flags a clean board is worth nothing, and that is the number worth knowing first."}</p>
        ${state.sample
          ? `<button class="primary" id="ro-go">Review this board</button>`
          : `<p class="hint">The review runs on Claude and this view cannot reach
             it. Everything else on the page works.</p>`}
      </div>`;
    overlay.querySelector("#ro-go")?.addEventListener("click", runReview);
    return;
  }

  const { caught, missed, other } = grade(findings, expectedFromState());
  const total = caught.length + missed.length;
  overlay.innerHTML = `
    <div class="ro-head">
      <h3>${findings.length} finding${findings.length === 1 ? "" : "s"}${
        state.verdict.cached ? " · from cache" : ""
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
          <b>${escapeHtml(finding.title)}</b>
          <span class="why">${escapeHtml(finding.why)}</span>
          <span class="tags">${[...finding.refs, ...finding.nets]
            .map((tag) => html`<code>${tag}</code>`)
            .join("")}</span>
          <span class="where">shown in ${escapeHtml(viewForFinding(finding))}</span>
        </button>`
      )
      .join("")}</div>
    <div class="ro-foot">Click a finding to put it on the board. The parts it
      names are ringed and its nets are lit.</div>`;

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
  if (svg.dataset.view !== "schematic") found = markDivergence(svg, state.board);
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
  note.innerHTML = parts.join(" ") +
    (state.view === "schematic"
      ? " <span class='muted'>Switch to Routing to see where.</span>"
      : "");
}

function renderReview() {
  const panel = $("review");
  const stream = $("review-stream");
  const button = $("go");

  if (!state.sample) {
    // Only the review needs Claude. Say which part, and say it without
    // implying the page is broken — everything that makes the board is here.
    panel.innerHTML = `<p class="muted">The review runs on Claude, and this view
      cannot reach it — open the page inside Claude to use it. Nothing else
      depends on it: breaking the board, the copper analysis above, the edit log
      and undo all run here.</p>`;
    button.hidden = true;
    stream.hidden = true;
    return;
  }
  button.hidden = false;
  button.disabled = state.reviewing;
  button.textContent = state.reviewing ? "Reviewing…" : "Review this board";
  stream.hidden = !state.reviewing;
  if (!state.reviewing) stream.textContent = "";

  $("budget").textContent = `${budget.left()} of ${SESSION_CAP} left · ${reviewCache.size()} cached`;

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
      <p class="hint">Everything else on the page runs here and is unaffected.</p>`;
    return;
  }

  if (!state.verdict) {
    const counts = islandCounts(state.board);
    const broken = [...counts.entries()].filter(([, n]) => n > 1);
    panel.innerHTML = state.log.length
      ? `<p class="muted">${state.log.length} edit${state.log.length === 1 ? "" : "s"} pending.
         ${broken.length ? `The copper already disagrees with the net list on
         ${broken.length} net${broken.length === 1 ? "" : "s"}.` : ""}</p>`
      : `<p class="muted">Review the board untouched first. A reviewer that
         flags a clean board is worth nothing, and that is the number worth
         knowing before any of the others.</p>`;
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
                <b>${escapeHtml(finding.title)}</b>
                <span class="why">${escapeHtml(finding.why)}</span>
                <span class="tags">${[...finding.refs, ...finding.nets]
                  .map((tag) => html`<code>${tag}</code>`)
                  .join("")}</span>
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
  const showing = view === "review" ? state.reviewSub : view;
  $("layer-chips").hidden = showing === "schematic";
  keptView = null;
  drawView({ keepZoom: false });
  renderOverlay();
  if (showing === "schematic") {
    // Compute it anyway: the count is worth saying even where it cannot be drawn.
    state.divergence = divergence(state.board);
    renderDivergenceNote();
  }
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
  renderPresets();
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
