/** The "this row's name was truncated by the keyword fallback" test, as SQL over
 *  the columns `cur_name` (what the row shows now) and `prev` (the pre_rerun
 *  snapshot). Both names are deliberately NOT column names on the table, so the
 *  fragment is unambiguous wherever it is spliced.
 *
 *  Its own module, with no imports, so the test that runs it against a real
 *  Postgres can read it without dragging in the platform env — and so the test
 *  runs THIS string rather than a hand-copied lookalike that can drift.
 *
 *  Used by repair-replay-truncated-names.ts, which writes to real workspace data
 *  and has no "the user typed this name" marker to defer to. That is why the
 *  predicate is this specific: an earlier draft used `prev LIKE cur_name || '%'`
 *  with no decimal check, and against the test's ten cases it fired on four rows
 *  it must not have touched, including a legitimate re-identify and a name
 *  containing a literal `%` (which LIKE reads as a wildcard). */
export const TRUNCATED_BY_FALLBACK_SQL = `
      length(cur_name) < length(prev)
  -- left()/length(), not LIKE: a name containing % or _ turns into a wildcard
  -- pattern that matches far more than the prefix it was built from.
  and left(prev, length(cur_name)) = cur_name
  -- the cut lands exactly on a DECIMAL POINT, which is this defect's
  -- fingerprint and not a shape a human types. Cutting at a comma or a real
  -- sentence end was always intended behaviour; only the decimal was wrong.
  and substring(prev from length(cur_name) + 1 for 2) ~ '^\\.[0-9]'
`;
