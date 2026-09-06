// The edit operations, in the browser. The mirror of harness/ops.py.
//
// Same nine operations, same log entries, same canonical text, same hash.
// tests/fixtures/ops.json is the shared fixture that keeps the two honest:
// tests/run.py applies it here through node and there through Python and
// requires identical hashes out of both.
//
// Schematic edits change the netlist only. The copper keeps the routing it was
// extracted with — see the note at the top of harness/ops.py for why.

export class OpError extends Error {}

// --------------------------------------------------------------------- lookup

export function findComponent(board, ref) {
  const comp = board.components.find((c) => c.ref === ref);
  if (!comp) throw new OpError(`no component ${ref}`);
  return comp;
}

export function findNet(board, name) {
  return board.nets.find((n) => n.name === name) || null;
}

export function findNode(board, ref, pin) {
  for (const net of board.nets) {
    const node = net.nodes.find((n) => n.ref === ref && n.pin === pin);
    if (node) return [net, node];
  }
  throw new OpError(`no pin ${ref}.${pin} on any net`);
}

export function findFootprint(board, ref) {
  const fp = board.layout.footprints.find((f) => f.ref === ref);
  if (!fp) throw new OpError(`no footprint ${ref}`);
  return fp;
}

function byId(items, id, what) {
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) throw new OpError(`no ${what} ${id}`);
  return [index, items[index]];
}

// ------------------------------------------------------------------ operations

export const OPS = {
  move_pin(board, { ref, pin, to_net }) {
    pin = String(pin);
    const [net, node] = findNode(board, ref, pin);
    if (net.name === to_net) throw new OpError(`${ref}.${pin} is already on ${to_net}`);

    let target = findNet(board, to_net);
    const created = target === null;
    if (created) {
      const code = board.nets.reduce((max, n) => Math.max(max, n.code || 0), 0) + 1;
      target = { name: to_net, code, nodes: [] };
      board.nets.push(target);
    }
    const index = net.nodes.indexOf(node);
    net.nodes.splice(index, 1);
    target.nodes.push(node);

    return {
      op: "move_pin",
      args: { ref, pin, to_net },
      from_net: net.name,
      from_index: index,
      created_net: created,
      label: `${ref}.${pin}: ${net.name} → ${to_net}`,
    };
  },

  swap_pins(board, { ref, pin_a, pin_b }) {
    pin_a = String(pin_a);
    pin_b = String(pin_b);
    const [netA, nodeA] = findNode(board, ref, pin_a);
    const [netB, nodeB] = findNode(board, ref, pin_b);
    if (netA === netB) throw new OpError(`${ref}.${pin_a} and ${ref}.${pin_b} are the same net`);

    const nameA = netA.name;
    const nameB = netB.name;
    // Each node goes back where the other one was, so a swap is exactly its own
    // inverse — position included, not just membership.
    const indexA = netA.nodes.indexOf(nodeA);
    const indexB = netB.nodes.indexOf(nodeB);
    netA.nodes.splice(indexA, 1, nodeB);
    netB.nodes.splice(indexB, 1, nodeA);

    return {
      op: "swap_pins",
      args: { ref, pin_a, pin_b },
      label: `${ref}: pin ${pin_a} ↔ pin ${pin_b} (${nameA} ↔ ${nameB})`,
    };
  },

  set_value(board, { ref, value }) {
    const comp = findComponent(board, ref);
    const before = comp.value;
    if (before === value) throw new OpError(`${ref} is already ${value}`);
    comp.value = value;
    return {
      op: "set_value",
      args: { ref, value },
      from_value: before,
      label: `${ref}: value '${before}' → '${value}'`,
    };
  },

  move_footprint(board, { ref, x, y }) {
    const fp = findFootprint(board, ref);
    const before = [fp.x, fp.y];
    fp.x = round4(x);
    fp.y = round4(y);
    return {
      op: "move_footprint",
      args: { ref, x: fp.x, y: fp.y },
      from_xy: before,
      label: `${ref}: moved to (${fp.x.toFixed(2)}, ${fp.y.toFixed(2)}) mm`,
    };
  },

  rotate_footprint(board, { ref, deg }) {
    const fp = findFootprint(board, ref);
    const before = fp.rot;
    const after = round4(mod360(deg));
    if (after === mod360(before)) throw new OpError(`${ref} is already at ${deg} degrees`);
    fp.rot = after;
    return {
      op: "rotate_footprint",
      args: { ref, deg: after },
      from_rot: before,
      label: `${ref}: rotated to ${trim(after)}°`,
    };
  },

  delete_track(board, { track_id }) {
    const tracks = board.layout.tracks;
    const [index, track] = byId(tracks, track_id, "track");
    tracks.splice(index, 1);
    return {
      op: "delete_track",
      args: { track_id },
      index,
      track,
      label: `deleted ${trim(track.width)} mm ${track.net || "unnamed"} track on ${track.layer}`,
    };
  },

  set_track_width(board, { track_id, mm }) {
    const [, track] = byId(board.layout.tracks, track_id, "track");
    const before = track.width;
    track.width = round4(mm);
    return {
      op: "set_track_width",
      args: { track_id, mm: track.width },
      from_width: before,
      label: `${track.net || "unnamed"} track: ${trim(before)} → ${trim(track.width)} mm`,
    };
  },

  delete_via(board, { via_id }) {
    const vias = board.layout.vias;
    const [index, via] = byId(vias, via_id, "via");
    vias.splice(index, 1);
    return {
      op: "delete_via",
      args: { via_id },
      index,
      via,
      label: `deleted ${via.net || "unnamed"} via at (${via.x.toFixed(1)}, ${via.y.toFixed(1)})`,
    };
  },

  toggle_zone(board, { zone_id }) {
    const [, zone] = byId(board.layout.zones, zone_id, "zone");
    const nowOff = !zone.disabled;
    if (nowOff) zone.disabled = true;
    else delete zone.disabled;
    return {
      op: "toggle_zone",
      args: { zone_id },
      disabled: nowOff,
      label: `${nowOff ? "removed" : "restored"} ${zone.net || "unnamed"} pour on ${zone.layer}`,
    };
  },
};

const UNDOS = {
  move_pin(board, entry) {
    const { ref, pin } = entry.args;
    const [net, node] = findNode(board, ref, pin);
    const home = findNet(board, entry.from_net);
    if (!home) throw new OpError(`net ${entry.from_net} vanished; cannot undo`);
    net.nodes.splice(net.nodes.indexOf(node), 1);
    home.nodes.splice(entry.from_index ?? home.nodes.length, 0, node);
    if (entry.created_net && net.nodes.length === 0) {
      board.nets.splice(board.nets.indexOf(net), 1);
    }
  },
  swap_pins(board, entry) {
    OPS.swap_pins(board, entry.args); // a swap is its own inverse
  },
  set_value(board, entry) {
    findComponent(board, entry.args.ref).value = entry.from_value;
  },
  move_footprint(board, entry) {
    const fp = findFootprint(board, entry.args.ref);
    [fp.x, fp.y] = entry.from_xy;
  },
  rotate_footprint(board, entry) {
    findFootprint(board, entry.args.ref).rot = entry.from_rot;
  },
  delete_track(board, entry) {
    board.layout.tracks.splice(entry.index, 0, entry.track);
  },
  set_track_width(board, entry) {
    const [, track] = byId(board.layout.tracks, entry.args.track_id, "track");
    track.width = entry.from_width;
  },
  delete_via(board, entry) {
    board.layout.vias.splice(entry.index, 0, entry.via);
  },
  toggle_zone(board, entry) {
    OPS.toggle_zone(board, entry.args); // a toggle is its own inverse
  },
};

export function applyEdit(board, edit) {
  const fn = OPS[edit.op];
  if (!fn) throw new OpError(`unknown operation ${edit.op}`);
  return fn(board, edit.args || {});
}

export function applyEdits(board, edits) {
  return edits.map((edit) => applyEdit(board, edit));
}

export function undo(board, log) {
  if (!log.length) return null;
  const entry = log.pop();
  UNDOS[entry.op](board, entry);
  return entry;
}

// -------------------------------------------------------------------- hashing

// harness/ops.py `round4` is written to match this exactly. Do not change one
// without the other: the board hash is the review cache key.
function round4(value) {
  return Math.round(Number(value) * 1e4) / 1e4;
}

function mod360(deg) {
  return ((Number(deg) % 360) + 360) % 360;
}

function trim(value) {
  return String(Number(value));
}

// The one millimetre format, agreed with harness/ops.py `mm()`. JSON is not a
// usable basis for a cross-language hash — Python writes 61.0 where JavaScript
// writes 61 — but a fixed four-decimal string is identical in both.
export function mm(value) {
  let number = Number(value);
  if (Math.abs(number) < 5e-5) number = 0;
  return number.toFixed(4);
}

export function canonical(board) {
  const layout = board.layout;
  const lines = [`size ${mm(layout.size.w)} ${mm(layout.size.h)}`];
  const by = (key) => (a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);

  for (const c of [...board.components].sort(by("ref"))) {
    lines.push(`C ${c.ref} ${c.value} ${c.footprint}`);
  }
  for (const net of [...board.nets].sort(by("name"))) {
    const nodes = net.nodes.map((n) => `${n.ref}.${n.pin}`).sort();
    lines.push(`N ${net.name} ${nodes.join(" ")}`);
  }
  for (const f of [...layout.footprints].sort(by("ref"))) {
    lines.push(`F ${f.ref} ${mm(f.x)} ${mm(f.y)} ${mm(f.rot)} ${f.layer}`);
  }
  for (const t of [...layout.tracks].sort(by("id"))) {
    lines.push(
      `T ${t.id} ${mm(t.x1)} ${mm(t.y1)} ${mm(t.x2)} ${mm(t.y2)} ${mm(t.width)} ${t.layer} ${t.net}`
    );
  }
  for (const v of [...layout.vias].sort(by("id"))) {
    lines.push(`V ${v.id} ${mm(v.x)} ${mm(v.y)} ${mm(v.size)} ${mm(v.drill)} ${v.net}`);
  }
  for (const z of [...layout.zones].sort(by("id"))) {
    lines.push(`Z ${z.id} ${z.net} ${z.layer} ${z.disabled ? "off" : "on"}`);
  }
  return lines.join("\n");
}

// Python sorts strings by code point and so does JavaScript's default `<`, but
// `Array.prototype.sort` on ids like t1, t10, t2 is lexicographic in both, so
// the orders agree. The 16 hex characters match `harness.ops.board_hash`.
export async function boardHash(board) {
  const bytes = new TextEncoder().encode(canonical(board));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}
