// The three edits step 9 names, through the modules the page actually calls.
//
// Drag a footprint, delete a track, reassign a pin: each must produce one log
// entry a person can read, and undo must put the board back. Pointer events are
// the browser's job and are checked by hand; everything between the pointer and
// the board is checked here.
//
//   node tests/edit_cycle.mjs

import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { applyEdit, boardHash, undo, OPS, findNode } = await import(
  "file://" + join(root, "site", "ops.js")
);

const board = JSON.parse(readFileSync(join(root, "boards", "stm32-good.json"), "utf8"));
const app = readFileSync(join(root, "site", "app.js"), "utf8");
const page = readFileSync(join(root, "site", "index.html"), "utf8");

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

const work = JSON.parse(JSON.stringify(board));
const before = await boardHash(work);
const log = [];

// 1. Drag a footprint. The page previews the move live and records it once on
//    release, so one drag is one entry rather than two hundred.
{
  const entry = applyEdit(work, { op: "move_footprint", args: { ref: "C6", x: 20.5, y: 11.25 } });
  log.push(entry);
  check(/C6/.test(entry.label), `move label names the part: ${entry.label}`);
  check(/20\.50/.test(entry.label), `move label states where it went: ${entry.label}`);
  const fp = work.layout.footprints.find((f) => f.ref === "C6");
  check(fp.x === 20.5 && fp.y === 11.25, "the footprint actually moved");
}

// 2. Delete a track.
{
  const track = work.layout.tracks.find((t) => t.net === "GND");
  const count = work.layout.tracks.length;
  const entry = applyEdit(work, { op: "delete_track", args: { track_id: track.id } });
  log.push(entry);
  check(/deleted/.test(entry.label) && /GND/.test(entry.label), `delete label reads: ${entry.label}`);
  check(work.layout.tracks.length === count - 1, "the track is gone");
}

// 3. Reassign a pin.
{
  const entry = applyEdit(work, { op: "move_pin", args: { ref: "S1", pin: "4", to_net: "VBST" } });
  log.push(entry);
  check(/S1\.4/.test(entry.label), `pin label names the pin: ${entry.label}`);
  check(/\/FB/.test(entry.label) && /VBST/.test(entry.label), `pin label names both nets: ${entry.label}`);
  const [net] = findNode(work, "S1", "4");
  check(net.name === "VBST", "the pin moved to the new net");
  // The copper is deliberately untouched: a schematic edit is a schematic edit.
  const pad = work.layout.footprints.find((f) => f.ref === "S1").pads.find((p) => p.num === "4");
  check(pad.net === "/FB", "the pad keeps the net the board was routed with");
}

check(log.length === 3, `three edits make three log entries, got ${log.length}`);
check(
  new Set(log.map((e) => e.label)).size === 3,
  "each entry reads differently, so the log is legible"
);

while (log.length) undo(work, log);
check((await boardHash(work)) === before, "undo restores the board exactly");

// Every operation has to have a control that records it. This is a grep, and
// a grep cannot tell whether the control can be reached — one of these passed
// while pointer capture was swallowing every click in the board views, which is
// what tests/pointer.mjs is for.
for (const name of Object.keys(OPS)) {
  check(app.includes(`op: "${name}"`), `app.js has no control that records ${name}`);
}
check(/applyEdit\(/.test(app), "app.js goes through applyEdit rather than touching the board");
check(!/board\.layout\.tracks\.splice|board\.components\.find\([^)]*\)\.value\s*=/.test(app),
  "app.js must not mutate the board outside an operation");
for (const id of ["undo", "reset", "log", "inspector", "presets", "go", "stage"]) {
  check(page.includes(`id="${id}"`), `index.html has no #${id}`);
}
check(/pointerdown|startDrag/.test(app), "app.js wires dragging");

for (const failure of failures) console.error("  x " + failure);
console.log(
  failures.length
    ? `${failures.length} edit-cycle checks failed`
    : `drag, delete and reassign each log one readable entry, undo restores ${before}, and app.js records all ${Object.keys(OPS).length} operations`
);
process.exit(failures.length ? 1 : 0);
