// Field/wire-level diff between two bundle manifests (audit F3) — powers the
// "what this update actually changes" block in BundleDetailModal, so an
// update isn't a leap of faith ("v2.0, trust me") but a concrete list:
// +2 fields, −1 wire, 1 field's choices changed.
//
// Pure + total: tolerates missing arrays, resolved-or-full manifests, and
// instance-scoped field defs (flattened with an instance prefix so a field
// moving between instances reads as remove+add — which is what it IS).

export interface Manifestish {
  field_defs?: Array<Record<string, unknown>>;
  wires?: Array<Record<string, unknown>>;
  field_overrides?: Array<Record<string, unknown>>;
  saved_views?: Array<Record<string, unknown>>;
  provides_instances?: Array<{
    instance_name?: string;
    field_defs?: Array<Record<string, unknown>>;
    saved_views?: Array<Record<string, unknown>>;
  }>;
}

export interface BundleDiff {
  fields: { added: string[]; removed: string[]; changed: string[] };
  wires: { added: string[]; removed: string[] };
  views: { added: string[]; removed: string[] };
  /** True when nothing differs — the caller can skip rendering. */
  empty: boolean;
}

interface Keyed {
  key: string;
  label: string;
  fingerprint: string;
}

function flatFields(m: Manifestish): Keyed[] {
  const out: Keyed[] = [];
  const push = (f: Record<string, unknown>, scope: string) => {
    const name = String(f.name ?? "?");
    const kind = String(f.entity_kind ?? "?");
    out.push({
      key: `${scope}${kind}.${name}`,
      label: `${String(f.display_label ?? name)}${scope ? ` (${scope.slice(0, -1)})` : ""}`,
      // Order-insensitive fingerprint of the bits a user would notice.
      fingerprint: JSON.stringify({
        type: f.type,
        choices: f.choices,
        help: f.help,
        display_label: f.display_label,
        required: f.required,
        template: f.template,
      }),
    });
  };
  for (const f of m.field_defs ?? []) push(f, "");
  for (const inst of m.provides_instances ?? []) {
    for (const f of inst.field_defs ?? []) push(f, `${inst.instance_name ?? "instance"}:`);
  }
  return out;
}

function flatWires(m: Manifestish): Keyed[] {
  return (m.wires ?? []).map((w) => {
    const src = String(w.source_kind ?? "?");
    const act = String(w.action_id ?? "?");
    const trig = String(w.trigger_event ?? w.trigger_type ?? "?");
    return {
      key: `${src}→${act}@${trig}`,
      label: `${src} → ${act} (${trig})`,
      fingerprint: JSON.stringify({ template: w.template, args: w.args, target: w.target }),
    };
  });
}

function flatViews(m: Manifestish): Keyed[] {
  const out: Keyed[] = [];
  const push = (v: Record<string, unknown>, scope: string) =>
    out.push({
      key: `${scope}${String(v.entity_kind ?? "?")}.${String(v.name ?? "?")}`,
      label: String(v.name ?? "?"),
      fingerprint: JSON.stringify(v.config ?? null),
    });
  for (const v of m.saved_views ?? []) push(v, "");
  for (const inst of m.provides_instances ?? []) {
    for (const v of inst.saved_views ?? []) push(v, `${inst.instance_name ?? "instance"}:`);
  }
  return out;
}

function diffKeyed(from: Keyed[], to: Keyed[]): { added: string[]; removed: string[]; changed: string[] } {
  const a = new Map(from.map((k) => [k.key, k]));
  const b = new Map(to.map((k) => [k.key, k]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [key, k] of b) {
    const prev = a.get(key);
    if (!prev) added.push(k.label);
    else if (prev.fingerprint !== k.fingerprint) changed.push(k.label);
  }
  for (const [key, k] of a) if (!b.has(key)) removed.push(k.label);
  return { added, removed, changed };
}

/** Diff `from` (installed) → `to` (incoming). */
export function diffManifests(from: Manifestish, to: Manifestish): BundleDiff {
  const fields = diffKeyed(flatFields(from), flatFields(to));
  const wiresFull = diffKeyed(flatWires(from), flatWires(to));
  const viewsFull = diffKeyed(flatViews(from), flatViews(to));
  // A changed wire/view reads clearest as remove+add of the same label.
  const wires = {
    added: [...wiresFull.added, ...wiresFull.changed.map((l) => `${l} (changed)`)],
    removed: wiresFull.removed,
  };
  const views = {
    added: [...viewsFull.added, ...viewsFull.changed.map((l) => `${l} (changed)`)],
    removed: viewsFull.removed,
  };
  const empty =
    !fields.added.length && !fields.removed.length && !fields.changed.length &&
    !wires.added.length && !wires.removed.length &&
    !views.added.length && !views.removed.length;
  return { fields, wires, views, empty };
}
