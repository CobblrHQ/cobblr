#!/usr/bin/env tsx
// A write that marks background work finished (a read done, a turn done, a step done) comes after the work's payload is written, or with it in one statement or transaction, never before: a reader that sees the finished state must find what it finished.
//
// THE BUG THIS PREVENTS. 2026-10-05: the pattern read answered "ready" with no
// needs (main red, runs 35417 and 36996): its reader asked for the needs, then
// the status, and the writer flipped the status after writing the needs, so a
// read landing between the two queries was torn. An audit of every endpoint that
// answers "state + payload" for background work found the same shape five more
// times, all on the WRITER side: a receipt session marked read before its lines
// existed (the inbox dropped it), a chat turn marked done before its answer
// event (a JSON poller got "done" and nothing), a make step marked done before
// its files, a plate's verdict claimed outside the transaction that counts it,
// and a scan card's "finished" written a statement before "reading a receipt".
//
// THE RULE. The writer orders it: payload first, state last (or one statement,
// or one transaction). Then a reader is safe in either order. Every such state
// is registered below: the statement that flips it to finished, and the writes
// of its payload. In a function that flips it, no payload write may follow the
// flip. A transaction (`.transaction()`) between them is the one exception: both
// commit together.
//
// AND THE READER (2026-10-05, after #4893). Ordering the writer is half: a
// reader that reads the payload first still reads it empty before the writer
// wrote it and the state "ready" after the writer flipped it, which is the
// pattern-needs bug's own reader. So every registered state names its readers'
// two reads too, and a function that reads the payload before the state is
// refused unless both are inside one readSnapshot (@cobblr/platform-contract/
// torn-reads: one REPEATABLE READ snapshot, order-free). tornInterleavings in
// the same file proves an order against a writer at every landing point.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. A registry, not a guess: a
// generic "a status write followed by any write" flagged every handler that
// marks a row done and then logs history. Each registered pair is one async
// state and its own payload. A new background state that a poller reads joins
// the registry in the same change. A deliberate exception says
// `state-flips-last: <why>` on the flip's line.
//
//   npx tsx scripts/lint-state-flips-last.ts   (pnpm lint state-flips-last)
import { readFileSync } from "node:fs";
import { repoFiles } from "./lib/repo-files.ts";

export interface FinishedState {
  /** What it is, for the message. */
  name: string;
  /** Its readers' two reads: the state, and the payload, which must come after. */
  reader?: { state: RegExp; payload: RegExp; files?: RegExp };
  /** A statement that flips it to finished. */
  flip: RegExp;
  /** Writes of its payload, which must not come after the flip. */
  payload: RegExp[];
}

export const STATES: FinishedState[] = [
  {
    name: "a chat turn's done/failed status (core_ai_chat_turns)",
    reader: { state: /readTurn\(/, payload: /eventsAfter\(/ },
    flip: /updateTable\("core_ai_chat_turns"\)[\s\S]{0,300}?status: "(done|failed)"/,
    payload: [/emitTurnEvent\(/],
  },
  {
    name: "a receipt session's read_state \"read\" (core_scan_batches)",
    reader: { state: /sessionsWithoutRows\(|batchLabelsFor\(/, payload: /selectFrom\("core_scan_inbox_items"\)|facetQuery/ },
    flip: /read_state: "read"/,
    payload: [/materializeReceiptLines\(/, /insertInto\("core_scan_inbox_items"\)/],
  },
  {
    name: "a pattern read's \"ready\" (projects_pattern_reads)",
    reader: { state: /selectFrom\("projects_pattern_reads"\)/, payload: /listNeeds\(/ },
    flip: /recordRead\([^)]*status: "ready"/,
    payload: [/writeNeeds\(/],
  },
  {
    name: "a make step's finished status (digifab_make_steps)",
    reader: { state: /stepsOf\(/, payload: /filesOf\(/ },
    flip: /insertInto\("digifab_make_steps"\)[\s\S]{0,200}?\.values\(\{ make_id: make\.id, step, \.\.\.values \}\)/,
    payload: [/attachToStep\(/],
  },
  {
    name: "a scan card's finished read (core_scan_inbox_items.ai_suggested_at)",
    flip: /await patchNote\(ctx, note\);/,
    payload: [/reading_receipt: true/],
  },
  {
    name: "a plate's verdict outside the run's count (digifab_jobs.run_outcome)",
    // Its writer is one transaction, so ANY two separate reads tear (in either
    // order): its readers read in a snapshot.
    reader: { state: /selectFrom\("digifab_jobs"\)/, payload: /selectFrom\("digifab_production_runs"\)/, files: /modules\/digifab\/src\/api\/runs\.ts$/ },
    flip: /const claim = await db\s*\.updateTable\("digifab_jobs"\)/,
    payload: [/updateTable\("digifab_production_runs"\)/],
  },
];

interface Violation {
  file: string;
  line: number;
  what: string;
}

/** The bodies of the functions in a file. The parameter list is balanced by
 *  parentheses and the return type by angle brackets, so a `{` in either (an
 *  object type) is not taken for the body. */
function functionBodies(src: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  const heads = /(?:\bfunction\s+\w+\s*|\basync\s*)\(/g;
  for (const m of src.matchAll(heads)) {
    let i = (m.index ?? 0) + m[0].length - 1;
    let paren = 0;
    for (; i < src.length; i++) {
      if (src[i] === "(") paren++;
      else if (src[i] === ")" && --paren === 0) break;
    }
    let angle = 0;
    let open = -1;
    for (let k = i + 1; k < src.length && k < i + 400; k++) {
      const c = src[k];
      if (c === "<") angle++;
      else if (c === ">" && src[k - 1] !== "=") angle = Math.max(0, angle - 1);
      else if (c === "{" && angle === 0) {
        open = k;
        break;
      } else if ((c === ";" || c === ",") && angle === 0 && !/=>\s*$/.test(src.slice(i, k))) break;
    }
    if (open < 0) continue;
    let depth = 0;
    for (let k = open; k < src.length; k++) {
      if (src[k] === "{") depth++;
      else if (src[k] === "}" && --depth === 0) {
        out.push({ start: open, end: k });
        break;
      }
    }
  }
  return out;
}

export function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  const lineOf = (i: number) => src.slice(0, i).split("\n").length;
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const seen = new Set<string>();
  for (const body of functionBodies(src)) {
    const text = src.slice(body.start, body.end);
    for (const st of STATES) {
      for (const flip of text.matchAll(new RegExp(st.flip.source, "g"))) {
        const at = body.start + (flip.index ?? 0);
        const ln = lineOf(at);
        if (lines.slice(Math.max(0, ln - 4), ln).some((l) => /state-flips-last: \S/.test(l))) continue;
        const flipIndent = indentOf(lines[ln - 1] ?? "");
        const after = text.slice((flip.index ?? 0) + flip[0].length);
        for (const p of st.payload) {
          const later = p.exec(after);
          if (!later) continue;
          // A bare `return` at the flip's own depth or shallower ends that path
          // before the payload write below it (a branch that finished its work).
          // A guard (`if (x) return ...`) does not.
          const between = after.slice(0, later.index).split("\n").slice(1);
          if (between.some((l) => /^return\b/.test(l.trim()) && indentOf(l) <= flipIndent)) continue;
          const key = `${ln}:${st.name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ file, line: ln, what: `${st.name} is marked finished before its payload is written (${p.source} at line ${lineOf(at + flip[0].length + later.index)}): write the payload first, or both in one statement or transaction` });
        }
      }
    }
  }
  // The reader half: in one function, the payload is not read before the state,
  // unless both are inside a readSnapshot.
  for (const body of functionBodies(src)) {
    const text = src.slice(body.start, body.end);
    // Inside a snapshot (the body holds a readSnapshot, or is its callback): order-free.
    if (/readSnapshot\(/.test(text) || /readSnapshot\([^]{0,80}$/.test(src.slice(Math.max(0, body.start - 80), body.start))) continue;
    for (const st of STATES) {
      if (!st.reader) continue;
      if (st.reader.files && !st.reader.files.test(file)) continue;
      const pay = st.reader.payload.exec(text);
      const state = st.reader.state.exec(text);
      if (!pay || !state || pay.index > state.index) continue;
      // A branch that reads only the payload and returns never reaches the state read below it.
      const payIndent = indentOf(lines[lineOf(body.start + pay.index) - 1] ?? "");
      const gap = text.slice(pay.index, state.index).split("\n").slice(1);
      if (gap.some((l) => /^return\b/.test(l.trim()) && indentOf(l) <= payIndent)) continue;
      const ln = lineOf(body.start + pay.index);
      if (lines.slice(Math.max(0, ln - 4), ln).some((l) => /state-flips-last: \S/.test(l))) continue;
      const key = `${ln}:reader:${st.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ file, line: ln, what: `reads ${st.name}'s payload before its state (line ${lineOf(body.start + state.index)}): a read finishing in between answers finished-and-empty; read the state first, or both in one readSnapshot` });
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = repoFiles(["modules", "api/src"]).filter((f) => /\.ts$/.test(f) && !/\.test\.ts$|\.d\.ts$/.test(f));
  const violations = files.flatMap((f) => check(f, readFileSync(f, "utf8")));
  if (violations.length) {
    console.error(`lint:state-flips-last - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error("A deliberate exception says `state-flips-last: <why>` on the flip's line.");
    process.exit(1);
  }
  console.log(`lint:state-flips-last OK (${files.length} files, ${STATES.length} registered states)`);
}
