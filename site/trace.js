// The trace page: what the review graph did, and what it was thinking.
//
// One board at a time. The pipeline diagram shows the path that board actually
// took — including the loop back, when the gate sent it round again — and the
// steps below it carry the job each node was given, the model's own reasoning,
// and what it proposed.
//
// The two kinds of step are drawn differently on purpose. `ingest` and `gate`
// are measurements: they run rule checks and copper geometry and no model is
// asked anything. The three reviewers and the adjudicator are a model talking.
// Which is which is the whole argument, so the page says it in the design
// rather than only in the prose.

const TRACE = JSON.parse(document.getElementById("trace-data").textContent);
const $ = (id) => document.getElementById(id);

let current = TRACE.boards[0].board;

const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

const boardOf = (name) => TRACE.boards.find((b) => b.board === name);

// --------------------------------------------------------------- the diagram

const NODES = ["ingest", "datasheet", "connections", "layout", "adjudicate", "gate"];
const NODE_H = 34;
const GAP = 22;

function pipelineSvg(board) {
  const ran = new Set(board.steps.map((s) => s.node));
  const looped = board.passes > 1;
  const rows = NODES.map((node, i) => {
    const y = 8 + i * (NODE_H + GAP);
    const measured = TRACE.measured.includes(node);
    const count = board.steps.filter((s) => s.node === node).length;
    return { node, y, measured, count, on: ran.has(node) };
  });

  const height = 8 + NODES.length * (NODE_H + GAP);
  const boxes = rows
    .map(
      (r) => `
      <g class="pnode ${r.measured ? "measured" : "model"}${r.on ? " on" : ""}"
         data-node="${r.node}">
        <rect x="64" y="${r.y}" width="196" height="${NODE_H}" rx="3"></rect>
        <text x="76" y="${r.y + 21}">${r.node}</text>
        ${r.count > 1 ? `<text class="times" x="248" y="${r.y + 21}">×${r.count}</text>` : ""}
      </g>`
    )
    .join("");

  const arrows = rows
    .slice(0, -1)
    .map((r) => {
      const y = r.y + NODE_H;
      return `<path class="pedge" d="M 162 ${y} L 162 ${y + GAP - 4}"></path>
              <path class="pedge head" d="M 158 ${y + GAP - 8} L 162 ${y + GAP - 3} L 166 ${y + GAP - 8}"></path>`;
    })
    .join("");

  const gateY = rows[rows.length - 1].y + NODE_H / 2;
  const backY = rows[1].y + NODE_H / 2;
  const loop = `
    <path class="ploop${looped ? " on" : ""}"
          d="M 64 ${gateY} C 22 ${gateY}, 22 ${backY}, 60 ${backY}"></path>
    <path class="ploop head${looped ? " on" : ""}" d="M 55 ${backY - 4} L 62 ${backY} L 55 ${backY + 4}"></path>
    <text class="ploop-label${looped ? " on" : ""}" x="18" y="${(gateY + backY) / 2}"
          transform="rotate(-90 18 ${(gateY + backY) / 2})">
      ${looped ? "went round again" : "or round again"}
    </text>`;

  return `<svg viewBox="0 0 300 ${height}" class="pipeline"
               role="img" aria-label="The review graph, top to bottom">
    ${loop}${arrows}${boxes}
  </svg>`;
}

// ------------------------------------------------------------------- the run

function chip(board) {
  const defect = board.defect;
  const caught = board.grade.caught.length > 0;
  const state = !defect ? "clean" : caught ? "caught" : "missed";
  return `<button class="bchip ${state}${board.board === current ? " on" : ""}"
    data-board="${esc(board.board)}">
    <span class="bchip-name">${esc(board.board)}</span>
    <span class="bchip-meta">${board.passes} pass${board.passes === 1 ? "" : "es"} ·
      ${board.confirmed.length} reported</span>
  </button>`;
}

function stepBody(step) {
  if (step.node === "ingest") {
    return `<p class="step-summary">${esc(step.summary)}</p>
      ${step.rules.length
        ? `<ul class="rules">${step.rules
            .map(
              (r) => `<li><code>${esc(r.rule)}</code> ${esc(r.title)}
                <span class="why">${esc(r.why)}</span></li>`
            )
            .join("")}</ul>`
        : `<p class="muted">Nothing for the loop to chase, so the gate stops after
             one pass whatever the reviewers say.</p>`}`;
  }

  if (step.node === "gate") {
    const again = step.decision === "again";
    return `<p class="gate-decision ${again ? "again" : ""}">
        <code>${esc(step.decision)}</code>
        ${again ? '<span class="gate-tag">back to datasheet</span>' : ""}
      </p>
      <p class="step-summary">${esc(step.why)}</p>
      <dl class="facts">
        <dt>rules fired</dt><dd>${step.rules.length ? esc(step.rules.join(", ")) : "none"}</dd>
        <dt>still unaccounted</dt><dd>${step.unaccounted.length ? esc(step.unaccounted.join(", ")) : "none"}</dd>
        <dt>proposed / reported</dt><dd>${step.proposed} / ${step.confirmed}</dd>
      </dl>`;
  }

  const dropped = (step.dropped || []).length
    ? `<h4 class="eyebrow">Thrown out by the board, with no model consulted</h4>
       <ul class="dropped">${step.dropped
         .map(
           (d) => `<li><b>${esc(d.title)}</b><span class="why">${esc(d.because)}</span></li>`
         )
         .join("")}</ul>`
    : "";
  const kept = (step.confirmed || []).length
    ? `<h4 class="eyebrow">Reported</h4>
       <ul class="kept">${step.confirmed.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`
    : "";

  return `
    <details class="job">
      <summary>The job it was given</summary>
      <pre>${esc(step.job)}</pre>
    </details>
    <h4 class="eyebrow">Thinking</h4>
    <pre class="reasoning">${esc(step.reasoning) || "<span class='muted'>none returned</span>"}</pre>
    ${dropped}${kept}
    ${step.found !== undefined && !dropped && !kept
      ? `<p class="step-summary">Proposed ${step.found} finding${step.found === 1 ? "" : "s"}.</p>`
      : ""}`;
}

function renderBoard(name) {
  current = name;
  const board = boardOf(name);
  $("chips").innerHTML = TRACE.boards.map(chip).join("");
  for (const button of $("chips").querySelectorAll(".bchip")) {
    button.addEventListener("click", () => renderBoard(button.dataset.board));
  }

  $("pipeline").innerHTML = pipelineSvg(board);

  const defect = board.defect;
  $("board-head").innerHTML = `
    <h2>${esc(board.title)}</h2>
    ${defect
      ? `<p class="lede">${esc(defect.breaks)}</p>`
      : `<p class="lede">Nothing was changed — this is the false-alarm rate.</p>`}
    <dl class="facts">
      <dt>board hash</dt><dd>${esc(board.board_hash)}</dd>
      <dt>sent</dt><dd>${board.distilled_tokens} tokens</dd>
      <dt>passes</dt><dd>${board.passes} of ${TRACE.max_passes}</dd>
      <dt>stopped</dt><dd><code>${esc(board.stopped)}</code></dd>
      <dt>proposed → reported</dt><dd>${board.proposed} → ${board.confirmed.length}</dd>
      <dt>refuted by the board</dt><dd>${board.dropped.length} dropped,
        ${board.refuted_reported.length} still reported</dd>
      <dt>cost</dt><dd>$${board.dollars.toFixed(4)} · ${board.seconds}s ·
        ${board.tokens_in.toLocaleString()} in, ${board.tokens_out.toLocaleString()} out</dd>
    </dl>`;

  $("steps").innerHTML = board.steps
    .map((step, i) => {
      const measured = step.measured;
      const meta = measured
        ? "measured"
        : `${step.tokens_out.toLocaleString()} tokens out · ${step.seconds}s`;
      const looping = step.node === "gate" && step.decision === "again";
      return `<article class="step ${measured ? "measured" : "model"}${looping ? " looping" : ""}">
        <header>
          <span class="step-n">${String(i + 1).padStart(2, "0")}</span>
          <span class="step-node">${esc(step.node)}</span>
          ${step.pass ? `<span class="step-pass">pass ${step.pass}</span>` : ""}
          <span class="step-meta">${esc(meta)}</span>
        </header>
        <p class="role">${esc(TRACE.roles[step.node] || "")}</p>
        ${stepBody(step)}
      </article>`;
    })
    .join("");

  $("distilled").textContent = board.distilled;
  document.querySelector(".run").scrollTop = 0;
}

$("totals").textContent =
  `${TRACE.totals.boards} boards · ${TRACE.totals.calls} model calls · ` +
  `${(TRACE.totals.tokens_out / 1000).toFixed(0)}k tokens of output · ` +
  `$${TRACE.totals.dollars} · ${TRACE.totals.seconds}s`;
$("model-line").textContent = `${TRACE.model} · prompts ${TRACE.prompt_hash} · ${TRACE.at}`;

renderBoard(current);
