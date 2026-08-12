// "Did a PRIOR delivery of this exact message already land something?"
//
// Lives in its own module so the test can compile the REAL predicate rather
// than a copy of it. A copied fragment in a test asserts that the copy is
// correct, which is precisely the thing that was never in doubt.
//
// See scripts/lint-sql-or-precedence.ts for why the parens matter.

import { sql } from "kysely";

/**
 * Landed something = created items, or saved a note.
 *
 * The outer parens are LOAD-BEARING. This fragment is injected verbatim into a
 * chain of `.where()` calls that join with AND, and AND binds tighter than OR.
 * Unparenthesised, `A AND B AND (items <> 0 OR note)` degrades to
 * `(A AND B AND items <> 0) OR note` — the OR escapes the message_id scope, and
 * a single archived row with note=true then answers "yes, already processed"
 * for every message ever sent. That shipped, and it silently dropped every
 * forwarded receipt for nineteen days.
 */
export const landedSomething = () =>
  sql<boolean>`(coalesce(outcome->>'item_count','0') <> '0' or coalesce((outcome->>'note')::boolean, false))`;
