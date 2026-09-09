/**
 * The one thing a model is shown about the board, in the browser.
 *
 * V8 has a single reviewer holding the whole board, so there is a single pack.
 * It used to be two - a circuit pack with no geometry and a physical pack with
 * no pin semantics - and the split was removed because five sweeps said it cost
 * recall: a reviewer holding half a board speculates about the other half.
 *
 * ONE DIFFERENCE FROM THE HARNESS, AND IT IS DELIBERATE
 *
 * The harness runs its sweeps offline, so its reviewer pack is the distilled
 * board and nothing else. The page can have more: if someone has attached a
 * datasheet to a part, what was read out of it goes in here. That is the whole
 * point of attaching one, and it is why the page's review can be better than
 * the sweep's on a board whose parts are documented.
 *
 * Both blocks are empty for a board nobody has attached anything to, which is
 * the ordinary state, and then the pack is exactly the distilled board.
 */

import { railCapacity } from "./checks.js";
import { distill } from "./distill.js";
import { factsBlock, passagesBlock } from "./docs.js";

export const PACK_VERSION = "2";

const join = (blocks) =>
  blocks.filter((b) => b && b.length).map((b) => b.join("\n")).join("\n\n");

/**
 * What the reviewer reads: the board, then whatever its documents state.
 *
 * Nothing here describes what is wrong with the board. The deterministic
 * findings are deliberately absent - naming them told the reviewer which
 * categories to skip and cost more recall than the duplicate findings it saved,
 * and on a seeded board it is the answer.
 */
export function reviewerPack(board) {
  return join([
    [distill(board)],
    railBlock(board),
    factsBlock(board),
    passagesBlock(board),
  ]);
}

/**
 * What each supply rail can carry, for every rail on the board.
 *
 * Every rail, not the interesting ones. A section listing only the rails
 * something is wrong with is a section that says which rail is wrong, and on a
 * seeded board that is the answer. Uniform or absent is the rule the whole pack
 * is built on.
 */
function railBlock(board) {
  const rails = railCapacity(board);
  if (!rails.length) return [];
  return [
    "RAIL CAPACITY  narrowest segment per supply rail, at 1 oz copper, outer layer, 10 C rise",
    ...rails.map((r) => `${r.net}: ${r.width_mm} mm carries about ${r.amps} A`),
  ];
}
