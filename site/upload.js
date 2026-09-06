// Load a KiCad project from the visitor's own machine.
//
// Nothing leaves the browser and nothing is asked of any API: the files are
// read with `File.text()` and parsed by site/kicad.js. A folder drop, a folder
// picker and a plain multi-file selection all end up in the same place.
//
// Two files matter. The `.kicad_pcb` is the board. The `.kicad_sch` is asked for
// because a footprint's `Reference` property is its *silkscreen* label — on the
// sample board eleven of the fifty-three say things like `LIN REG` — and the
// real designator only comes from joining the two on their shared UUID. The
// board loads without it, and says so.

import { buildBoard } from "./kicad.js";

const MAX_BYTES = 40 * 1024 * 1024;

/** Pick the board and schematic out of whatever was dropped. */
export function choose(files) {
  const all = [...files];
  const pcbs = all.filter((f) => f.name.toLowerCase().endsWith(".kicad_pcb"));
  const schs = all.filter((f) => f.name.toLowerCase().endsWith(".kicad_sch"));
  if (!pcbs.length) return { error: "No .kicad_pcb in there. Drop the project folder, or the board file itself." };

  // A project folder can hold backups and a .history directory; the shallowest
  // path is the real one, and the largest schematic is the root sheet.
  const depth = (f) => (f.webkitRelativePath || f.name).split("/").length;
  const pcb = pcbs.sort((a, b) => depth(a) - depth(b) || b.size - a.size)[0];
  const stem = pcb.name.replace(/\.kicad_pcb$/i, "");
  const sch =
    schs.find((f) => f.name.replace(/\.kicad_sch$/i, "") === stem) ||
    schs.sort((a, b) => depth(a) - depth(b) || b.size - a.size)[0] ||
    null;

  if (pcb.size > MAX_BYTES) {
    return { error: `${pcb.name} is ${(pcb.size / 1e6).toFixed(0)} MB, which is more than this page will read.` };
  }
  return { pcb, sch, name: stem };
}

/** Read and parse. Returns {board, notes} or throws with something readable. */
export async function load(files) {
  const picked = choose(files);
  if (picked.error) throw new Error(picked.error);

  const [pcbText, schText] = await Promise.all([
    picked.pcb.text(),
    picked.sch ? picked.sch.text() : Promise.resolve(null),
  ]);

  let board;
  try {
    board = buildBoard({ name: picked.name, pcbText, schText });
  } catch (error) {
    throw new Error(`${picked.pcb.name} could not be read: ${error.message}`);
  }

  const notes = [];
  if (!picked.sch) {
    notes.push(
      "No .kicad_sch came with it, so the part names are the silkscreen labels " +
        "off the board. Those are usually the designators and sometimes not."
    );
  } else if (board.meta.joined < board.layout.footprints.length) {
    notes.push(
      `${board.meta.joined} of ${board.layout.footprints.length} footprints matched a ` +
        "symbol in the schematic; the rest fell back to their silkscreen label."
    );
  }
  notes.push(
    "The schematic view shows where the parts sit on the sheet, not KiCad's " +
      "drawing — that picture comes from kicad-cli, which a web page cannot run."
  );
  return { board, notes, files: { pcb: picked.pcb.name, sch: picked.sch?.name || null } };
}

/**
 * Wire up a file input and a drop target.
 *
 * `onBoard(board, notes, files)` is called on success, `onError(message)` when
 * the files are not a board this can read.
 */
export function attachUpload({ input, dropZone, onBoard, onError, onBusy }) {
  const handle = async (files) => {
    if (!files || !files.length) return;
    onBusy?.(true);
    try {
      const result = await load(files);
      onBoard(result.board, result.notes, result.files);
    } catch (error) {
      onError(error.message || String(error));
    } finally {
      onBusy?.(false);
    }
  };

  input.addEventListener("change", () => {
    handle(input.files);
    input.value = ""; // so choosing the same folder twice fires again
  });

  if (!dropZone) return;
  const stop = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  for (const type of ["dragenter", "dragover"]) {
    dropZone.addEventListener(type, (event) => {
      stop(event);
      event.dataTransfer.dropEffect = "copy";
      dropZone.classList.add("dropping");
    });
  }
  for (const type of ["dragleave", "dragend"]) {
    dropZone.addEventListener(type, (event) => {
      stop(event);
      if (event.target === dropZone) dropZone.classList.remove("dropping");
    });
  }
  dropZone.addEventListener("drop", async (event) => {
    stop(event);
    dropZone.classList.remove("dropping");
    handle(await filesFrom(event.dataTransfer));
  });
}

/** Every file in a drop, walking into folders where the browser allows it. */
async function filesFrom(transfer) {
  const entries = [...(transfer.items || [])]
    .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
    .filter(Boolean);
  if (!entries.length) return [...(transfer.files || [])];

  const out = [];
  const walk = async (entry, path) => {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      // Keep the path so `choose` can prefer the shallowest board.
      Object.defineProperty(file, "webkitRelativePath", { value: path + entry.name });
      out.push(file);
      return;
    }
    if (!entry.isDirectory) return;
    // Skip KiCad's own backup and autosave folders, which hold older boards.
    if (/^(\.history|.*-backups)$/i.test(entry.name)) return;
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      for (const child of batch) await walk(child, path + entry.name + "/");
    }
  };
  for (const entry of entries) await walk(entry, "");
  return out;
}
