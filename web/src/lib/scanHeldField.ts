// A form input that is never re-seeded under a person's hands (#2982).
//
// The owner: "I was trying to edit the title on mobile and the page kept
// changing things as I went so I got kicked out of the title text box 10
// times!" The item screen's inputs were seeded from the served row, the
// inbox refetches while enrichment runs (a re-run, the picture sweep, the
// poll), and each refetch re-seeded the input, throwing the caret and the
// half-typed value away.
//
// The rule, for every input on the screen: the seed applies on open and on
// row-id change only. A field a person is editing (focused, or typed into)
// is never re-seeded; a server change to it is HELD, and offered as
// "updated underneath: use theirs / keep mine" only when the value actually
// differs from what they have. A field nobody touched follows the server.
//
// Pure rule + two hooks (one value, a record of values), so the rule is
// tested without a browser and the form reads as one line per field.

import { useCallback, useEffect, useRef, useState } from "react";

export type Eq<T> = (a: T, b: T) => boolean;
const same = <T,>(a: T, b: T): boolean => Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b);

/** Is the focused element the input for this field? Inputs carry
 *  data-field (the list layout) or sit in a data-chip-field host (a chip). */
export function fieldHasFocus(key: string, doc: Document | null = typeof document === "undefined" ? null : document): boolean {
  const el = doc?.activeElement;
  if (!el || typeof el.closest !== "function") return false;
  const host = el.closest("[data-field],[data-chip-field]");
  if (!host) return false;
  return (host.getAttribute("data-field") ?? host.getAttribute("data-chip-field")) === key;
}

/** What the field shows after the server's value moved. */
export function reconcileHeld<T>(
  cur: { value: T; dirty: boolean; focused: boolean },
  server: T,
  eq: Eq<T> = same,
): { value: T; theirs: T | null } {
  if (!cur.dirty && !cur.focused) return { value: server, theirs: null };
  return { value: cur.value, theirs: eq(server, cur.value) ? null : server };
}

export interface HeldField<T> {
  value: T;
  /** A person's edit: marks the field theirs. */
  set: (v: T) => void;
  /** The server's newer value, held because the person is on this field. */
  theirs: T | null;
  useTheirs: () => void;
  keepMine: () => void;
}

export function useHeldField<T>(key: string, server: T, eq: Eq<T> = same): HeldField<T> {
  const [value, setValue] = useState(server);
  const [theirs, setTheirs] = useState<T | null>(null);
  const valueRef = useRef(server);
  const dirty = useRef(false);
  const seen = useRef(server);
  useEffect(() => {
    if (eq(server, seen.current)) return;
    seen.current = server;
    const next = reconcileHeld({ value: valueRef.current, dirty: dirty.current, focused: fieldHasFocus(key) }, server, eq);
    if (!eq(next.value, valueRef.current)) {
      valueRef.current = next.value;
      setValue(next.value);
    }
    setTheirs(next.theirs);
  }, [server]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = useCallback(
    (v: T) => {
      dirty.current = true;
      valueRef.current = v;
      setValue(v);
      setTheirs((t) => (t !== null && eq(t, v) ? null : t));
    },
    [eq],
  );
  const useTheirs = useCallback(() => {
    setTheirs((t) => {
      if (t !== null) {
        dirty.current = false;
        valueRef.current = t;
        setValue(t);
      }
      return null;
    });
  }, []);
  const keepMine = useCallback(() => setTheirs(null), []);
  return { value, set, theirs, useTheirs, keepMine };
}

export type HeldRecord = Record<string, unknown>;

export interface HeldRecordField {
  values: HeldRecord;
  /** A person's edit of one key. */
  set: (key: string, v: unknown) => void;
  /** Seeds laid UNDER the person's values (a destination switch): not an edit. */
  seedUnder: (patch: HeldRecord) => void;
  /** The server's newer value per held key. */
  theirs: HeldRecord;
  useTheirs: (key: string) => void;
  keepMine: (key: string) => void;
}

/** The same rule over a record of fields (a table's own fields). `onAdopt`
 *  hears every value the form took from the server, so a writer that diffs
 *  against what it last sent does not send the server its own value back. */
export function useHeldRecord(seed: HeldRecord, onAdopt?: (key: string, v: unknown) => void): HeldRecordField {
  const [values, setValues] = useState(seed);
  const [theirs, setTheirs] = useState<HeldRecord>({});
  const valuesRef = useRef(seed);
  const theirsRef = useRef<HeldRecord>({});
  const dirty = useRef(new Set<string>());
  const seen = useRef(seed);
  const seedKey = JSON.stringify(seed);
  useEffect(() => {
    const prev = seen.current;
    if (JSON.stringify(prev) === seedKey) return;
    seen.current = seed;
    const nextValues = { ...valuesRef.current };
    const nextTheirs = { ...theirsRef.current };
    let changed = false;
    for (const k of new Set([...Object.keys(seed), ...Object.keys(prev)])) {
      if (same(seed[k], prev[k])) continue;
      const r = reconcileHeld({ value: valuesRef.current[k], dirty: dirty.current.has(k), focused: fieldHasFocus(k) }, seed[k]);
      if (!same(r.value, nextValues[k])) {
        if (r.value === undefined) delete nextValues[k];
        else nextValues[k] = r.value;
        onAdopt?.(k, r.value);
        changed = true;
      }
      if (r.theirs === null || r.theirs === undefined) delete nextTheirs[k];
      else nextTheirs[k] = r.theirs;
    }
    if (changed) {
      valuesRef.current = nextValues;
      setValues(nextValues);
    }
    theirsRef.current = nextTheirs;
    setTheirs(nextTheirs);
  }, [seedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = useCallback((key: string, v: unknown) => {
    dirty.current.add(key);
    valuesRef.current = { ...valuesRef.current, [key]: v };
    setValues(valuesRef.current);
    if (key in theirsRef.current && same(theirsRef.current[key], v)) {
      const t = { ...theirsRef.current };
      delete t[key];
      theirsRef.current = t;
      setTheirs(t);
    }
  }, []);
  const seedUnder = useCallback((patch: HeldRecord) => {
    valuesRef.current = { ...patch, ...valuesRef.current };
    setValues(valuesRef.current);
  }, []);
  const useTheirs = useCallback((key: string) => {
    if (!(key in theirsRef.current)) return;
    const v = theirsRef.current[key];
    dirty.current.delete(key);
    valuesRef.current = { ...valuesRef.current, [key]: v };
    setValues(valuesRef.current);
    const t = { ...theirsRef.current };
    delete t[key];
    theirsRef.current = t;
    setTheirs(t);
  }, []);
  const keepMine = useCallback((key: string) => {
    const t = { ...theirsRef.current };
    delete t[key];
    theirsRef.current = t;
    setTheirs(t);
  }, []);
  return { values, set, seedUnder, theirs, useTheirs, keepMine };
}
