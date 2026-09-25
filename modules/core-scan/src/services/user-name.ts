// A person's own name for a pending row, kept across every re-run (#2982).
//
// The owner renamed a row on his phone and on his desk and watched the name
// flip back: the re-run rewrote suggested_name, the closed card read the
// column, the open card read the candidate, and a refetch showed each in
// turn. #3014 gave the table's fields a `person` stamp that no pass may
// overwrite; the name is a field and gets the same, the same way: the
// person's value lives on the metadata (USER_NAME_KEY beside user_fields),
// stamped person in field_provenance, and is resolved over the column on
// every read (the contract's displayName, read by the api and the web).
// The model's writers are untouched; what they write is offered beside the
// person's name as the stamp's `replaced`, never shown in its place.

import {
  FIELD_PROVENANCE_KEY,
  fieldProvenanceOf,
  type FieldProvenanceMap,
} from "@cobblr/platform-contract/acquisition-source";
import { modelNameBeside, nameIsRejected, personNameOf, rejectedNamesOf, USER_NAME_KEY } from "@cobblr/platform-contract/display-identity";

/** `meta` after a person named the row: the name kept, stamped person. A
 *  blank name drops both, so the row reads as whatever the model says. */
export function applyPersonName(
  meta: Record<string, unknown>,
  name: string,
  at: string = new Date().toISOString(),
): Record<string, unknown> {
  const next = { ...meta };
  const stamps: FieldProvenanceMap = { ...fieldProvenanceOf(meta) };
  // A name the person turned down stays turned down whatever they type or
  // clear next: only the name they now give is taken off the list (#3724).
  const rejected = rejectedNamesOf(meta).filter((r) => r.trim().toLowerCase() !== name.trim().toLowerCase());
  if (!name.trim()) {
    delete next[USER_NAME_KEY];
    if (rejected.length) stamps.name = { by: "person", from: "rejected", at, rejected };
    else delete stamps.name;
  } else {
    next[USER_NAME_KEY] = name.trim();
    stamps.name = { by: "person", from: "rename", at, ...(rejected.length ? { rejected } : {}) };
  }
  if (Object.keys(stamps).length) next[FIELD_PROVENANCE_KEY] = stamps;
  else delete next[FIELD_PROVENANCE_KEY];
  return next;
}

/** `meta` after a person said the name is wrong ("Not right"): the name they
 *  were shown joins the turned-down list on the name's person stamp, and any
 *  name of their own goes with it. No later read may show a turned-down name
 *  (nameIsRejected); the row waits for theirs. */
export function applyRejectName(
  meta: Record<string, unknown>,
  shown: string | null | undefined,
  at: string = new Date().toISOString(),
): Record<string, unknown> {
  const name = shown?.trim();
  if (!name) return meta;
  const next = { ...meta };
  const stamps: FieldProvenanceMap = { ...fieldProvenanceOf(meta) };
  const prior = rejectedNamesOf(meta);
  const rejected = prior.some((r) => r.trim().toLowerCase() === name.toLowerCase()) ? prior : [...prior, name];
  delete next[USER_NAME_KEY];
  stamps.name = { by: "person", from: "rejected", at, rejected };
  next[FIELD_PROVENANCE_KEY] = stamps;
  return next;
}

/** A row on its way out: the person's name in suggested_name when they
 *  gave one, and the model's newest read (the column, when it differs)
 *  carried under the stamp as `replaced`. A row nobody renamed is returned
 *  as it was. Pure; the column is never written. */
export function withPersonName<T extends { suggested_name: string | null; suggested_metadata?: unknown }>(row: T): T {
  const person = personNameOf(row.suggested_metadata);
  // A name the person turned down is served as no name at all (#3724).
  if (!person) return nameIsRejected(row) ? { ...row, suggested_name: null } : row;
  const meta = { ...((row.suggested_metadata ?? {}) as Record<string, unknown>) };
  const stamps: FieldProvenanceMap = { ...fieldProvenanceOf(meta) };
  const beside = modelNameBeside(row);
  const stamp = stamps.name ?? { by: "person", from: "rename" };
  stamps.name = beside ? { ...stamp, replaced: beside } : stamp;
  meta[FIELD_PROVENANCE_KEY] = stamps;
  return { ...row, suggested_name: person, suggested_metadata: meta };
}
