// A sweep must not send one notification per row.
//
// Twice in one morning a person filing groceries got a stream of DMs:
//
//   Baby Carrots needs kept refrigerated - it just went into Kitchen
//   Cucumbers Long needs kept refrigerated - it just went into Kitchen
//   Tomatoes Roma needs kept refrigerated - it just went into Kitchen
//
//   Croissant - expired 12d ago
//   Roma Tomatoes - expired 10d ago
//   Cucumbers Long - expired 3d ago
//   ... three more
//
// Two different modules, one shape: `notifications.dispatch` called inside a
// loop over rows. Each author reasoned about ONE item, where the message is
// perfectly good, and neither reasoned about a stocked fridge.
//
// The delivery-window digest DOES combine these - but only for somebody who has
// configured a window, so the default experience of any workspace with data is
// a stream. Composing one message is not a user preference; it is what a batch
// job owes the person it writes to.
//
// THE RULE: collect the lines in the loop, dispatch once after it. A per-row
// EVENT is fine (wires are machines and want the detail); a per-row DM is not.
//
// WHAT THIS DOES NOT CATCH, stated so nobody trusts it further than it goes:
// only the SWEEP shape, where the fan-out is a visible loop. The storage-fit
// half of that morning was a single dispatch in an event handler that fires
// once per placement - no loop, so nothing here would have seen it. A loop is
// where this shape is legible to a static check; the other half needs a
// batcher (`modules/core-scan/src/services/storage-warn-batch.ts` is the
// pattern to copy).
//
// Deliberate exception, on the dispatch line or the line above:
//   // dispatch-per-row-ok: <why one row cannot become many>

import { readFileSync } from "node:fs";
import { sourceFiles } from "./lib/glob-exclude.mjs";

const OK = /dispatch-per-row-ok:/;

/** A `for`/`while`/`.map(`/`.forEach(` header — the loops that iterate rows. */
const LOOP = /^\s*(for\s*\(|while\s*\(|.*\.\s*(map|forEach|flatMap)\s*\()/;
/** The name a loop binds, so a dispatch can be asked where its `userId` came
 *  from. `for (const row of due)` binds `row`; `owners.map((m) =>` binds `m`. */
function loopBinding(line: string): string | null {
  return (
    /for\s*\(\s*(?:const|let|var)\s+(\w+)\s+of\b/.exec(line)?.[1] ??
    /\.\s*(?:map|forEach|flatMap)\s*\(\s*(?:async\s*)?\(?\s*(\w+)/.exec(line)?.[1] ??
    null
  );
}
/** Closing brace at or left of the loop's indent ends it — good enough for
 *  well-formatted TS, and this is a floor, not a proof. */
const offenders: string[] = [];

for (const file of sourceFiles("{api,modules,packages}/**/*.ts")) {
  let src: string;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (!src.includes("notifications.dispatch")) continue;
  const lines = src.split("\n");

  // Track the indent of every open loop; a dispatch inside one is a hit -
  // UNLESS the loop it sits in only iterates MEMBERS (one message each to
  // several people is correct; the fan-out this bans is over ROWS).
  const stack: Array<{ indent: number; binding: string | null }> = [];
  lines.forEach((line, i) => {
    const indent = line.search(/\S/);
    if (indent < 0) return;
    while (stack.length > 0 && indent <= stack[stack.length - 1]!.indent && /^\s*[})\]]/.test(line)) {
      stack.pop();
    }
    if (LOOP.test(line)) {
      stack.push({ indent, binding: loopBinding(line) });
      return;
    }
    if (!line.includes("notifications.dispatch")) return;
    if (OK.test(line) || OK.test(lines[i - 1] ?? "")) return;
    // DOES THE CONTENT VARY PER ITERATION? That is the whole question, and it
    // is answerable without guessing at variable names (two earlier attempts
    // guessed, and called `owners.map((m) => …)` and a per-workspace sweep
    // fan-outs over rows). A loop whose binding only supplies the ADDRESS -
    // `orgId:` and `userId:` - is iterating workspaces or people, which is
    // correct: the same message to several recipients. A loop whose binding
    // reaches the message, the entity, or the payload is composing a DIFFERENT
    // message each time round, which is the stream this bans.
    const addressed = lines
      .slice(i, i + 14)
      .filter((l) => !/^\s*(orgId|userId)\s*[:,]/.test(l))
      .join("\n");
    const rowLoops = stack.filter(
      (f) => f.binding !== null && new RegExp(`\\b${f.binding}\\b`).test(addressed),
    ).length;
    if (rowLoops > 0) {
      offenders.push(`${file}:${i + 1}  dispatch inside a loop over rows`);
    }
  });
}

if (offenders.length > 0) {
  console.error(
    "[lint:dispatch-not-per-row] ✗ a notification is sent per row:\n" +
      offenders.map((o) => `  ${o}`).join("\n") +
      "\n\n  A stocked workspace turns this into a stream of DMs - it happened twice\n" +
      "  in one morning, from two modules, both reasoned about a single item.\n" +
      "  Collect the lines in the loop and dispatch ONCE after it. A per-row\n" +
      "  EVENT is fine (wires want the detail); a per-row message is not.\n" +
      "  Genuine exception: `// dispatch-per-row-ok: <why>` on or above the line.",
  );
  process.exit(1);
}

console.log("[lint:dispatch-not-per-row] ✓ no notification fans out over rows");
