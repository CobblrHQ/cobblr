// What a provider's models ARE, asked of the provider rather than written here.
//
// The Cobb model picker on a Claude connection offered Sonnet 4.5, Haiku 4.5
// and Opus 4.5 and nothing newer, because the adapter wrote those three ids
// into code: a new generation never reached a picker until somebody edited a
// list, and every default stayed on the old one (#5417). A provider with a
// catalog instead says how to ask its own models endpoint, which family and
// version an id belongs to, and which jobs a listed model can do as a RULE
// (any image-capable Claude model can identify a photo), so the next
// generation qualifies with no code change.
//
// "Latest" per family is the default and moves with the listing: the picker
// shows "Haiku · latest (5.5)" first, the version filled in from what the key
// can use, and exact versions under it as pins that never move on their own.
// A latest id names a family, never a model, so it is resolved to a listed
// model before any call leaves (resolveListedModel) and never reaches the
// provider, the cache key or the cost ledger.
//
// Buildless subpath: types only from the index.

import type { AiCapability } from "./index.js";

/** One model a provider's own listing reported, as far as it said. */
export interface AiListedModel {
  id: string;
  /** The provider's own name for it ("Claude Haiku 4.5"), when it gave one. */
  label?: string;
  /** Whether it takes an image. Undefined when the listing did not say. */
  vision?: boolean;
}

export interface AiModelVersion {
  family: string;
  /** [5, 5] for 5.5, [5] for 5: compared element by element. */
  version: number[];
}

/** How one provider's models are listed and read. Lives with the adapter;
 *  the platform reads it through these pure helpers. */
export interface AiModelCatalog {
  /** The family and version an id names, or null for one outside every family. */
  parse(id: string): AiModelVersion | null;
  /** "Haiku" for "haiku". */
  familyLabel(family: string): string;
  /** The id that means "the newest of this family the key can use". Never
   *  sent to the provider. */
  latestId(family: string): string;
  /** The family a latest id names, else null. */
  familyOfLatest(id: string): string | null;
  /** Whether a listed model can do a job: a rule over what the listing says,
   *  never a list of names. */
  canDo(capability: AiCapability, model: AiListedModel): boolean;
  /** The families in the order a picker shows them; others follow by name. */
  familyOrder?: readonly string[];
  /** Ask the provider's own models endpoint with this key. Throws when it
   *  cannot be asked. */
  list(credentials: Record<string, unknown>): Promise<AiListedModel[]>;
  /** What the picker and the router use when the listing cannot be read (no
   *  network, a rate limit). One list per provider, kept beside its adapter. */
  fallback: readonly AiListedModel[];
}

/** One entry of a model picker for a job: a family's "latest" first, then
 *  exact versions to pin. */
export interface AiModelChoice {
  id: string;
  /** "Haiku · latest (5.5)" or "Haiku 4.5". */
  label: string;
  /** What fits on a pill: "Haiku" for latest, "Haiku 4.5" for a pin. */
  short: string;
  /** Present on a latest entry: its family and the model it means now. */
  latest?: { family: string; resolves: string };
  /** The model the provider answers with when this one is asked for: a
   *  deprecated model it redirects, learned from a call's served model. */
  redirectsTo?: string;
}

/** Requested id to the id a provider served for it, per connection: learned
 *  from calls whose served model was another model (servedModelDiffers). */
export type AiModelRedirects = Readonly<Record<string, string>>;

/** A served-model field as a provider sent it: a non-empty string, else
 *  null. Never falls back to the requested id. */
export function servedModelOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  return t ? t : null;
}

/** A model id that names whatever the provider currently points it at
 *  ("gemini-flash-lite-latest", an Ollama "llama3:latest"): it can change, or
 *  be overloaded for an hour, without anybody here touching anything. A
 *  provider answering one with a numbered model is the alias working, not a
 *  redirect. */
export function isFloatingModel(model: string): boolean {
  return /(^|[-:])latest$/i.test(model.trim());
}

/** A model too slow for a question asked at the camera (Quick look, the
 *  owner 2026-10-10: "Identifying scans/ photos in the moment needs to be
 *  quick"). The fuller tier of each family: Claude's Sonnet and Opus,
 *  Gemini's Pro and full Flash (Lite is the quick one), OpenAI's models
 *  outside its light tiers (mini, nano, Luna), and a local model of 30 billion parameters or more.
 *  The picker lists these after the quick ones, with a note; it never
 *  refuses one. */
export function slowForQuickLook(model: string): boolean {
  const m = model.trim().toLowerCase();
  if (/\b(haiku|lite|mini|nano|luna|flash-8b)\b/.test(m)) return false;
  if (/\b(sonnet|opus)\b/.test(m)) return true;
  if (/gemini/.test(m) && /\b(pro|flash)\b/.test(m)) return true;
  if (/^(gpt-(?!oss)|o[134]\b)/.test(m)) return true;
  const size = m.match(/(\d+(?:\.\d+)?)b\b/);
  return !!size && Number(size[1]) >= 30;
}

function bareModelId(id: string): string {
  return id.trim().replace(/^models\//, "").toLowerCase();
}

/**
 * Whether the model a provider said answered is another model than the one
 * asked for. The same model under its provider's spelling is not: Gemini's
 * "models/" prefix, a dated or numbered snapshot of the id asked for
 * ("claude-haiku-4-5" answered as "claude-haiku-4-5-20251001", "gpt-4o" as
 * "gpt-4o-2024-08-06"), and Ollama's
 * implicit ":latest" tag. A missing served model never differs: it is
 * unknown, not a match.
 */
export function servedModelDiffers(requested: string, served: string | null | undefined): boolean {
  if (!served) return false;
  const a = bareModelId(requested);
  const b = bareModelId(served);
  if (a === b) return false;
  if (b === `${a}:latest` || a === `${b}:latest`) return false;
  if (b.startsWith(`${a}-`) && /^(\d{3,8}|\d{4}-\d{2}-\d{2})$/.test(b.slice(a.length + 1))) return false;
  return true;
}

/** The model a call is priced as: the one that answered when it is another
 *  model than the one asked (a redirect is billed as what served it), else
 *  the one asked, whose price a dated snapshot of it shares. */
export function pricedModel(requested: string, served: string | null | undefined): string {
  return served && servedModelDiffers(requested, served) ? served : requested;
}

/** A busy ladder without the rungs that would ask a model again: a rung the
 *  provider redirects to a model an earlier rung is (or is served as) is the
 *  same model under an old name. Google still lists gemini-3.5-flash while
 *  serving it as 3.6, so a ladder of 3.6 then 3.5 asked busy 3.6 twice. */
export function ladderWithoutRedirects(ladder: readonly string[], redirects?: AiModelRedirects): string[] {
  if (!redirects) return [...ladder];
  const served = new Set<string>();
  const out: string[] = [];
  for (const rung of ladder) {
    const as = redirects[rung] ?? rung;
    if (served.has(as) || served.has(rung)) continue;
    served.add(as);
    served.add(rung);
    out.push(rung);
  }
  return out;
}

/** A picker entry for a model the provider redirects: "Flash 3.5 · redirects
 *  to Flash 3.6". */
export function redirectNote(label: string, to: string): string {
  return `${label} · redirects to ${to}`;
}

/** What a log shows for a call's model: "gemini-3.5-flash → gemini-3.6-flash"
 *  when another model answered, else the model asked for. */
export function servedModelText(requested: string | null | undefined, served: string | null | undefined): string {
  if (!requested) return served ?? "";
  return served && servedModelDiffers(requested, served) ? `${requested} → ${served}` : requested;
}

/** The listing with every model a listed one redirects to added beside it,
 *  carrying what the listing said of the model it stands in for: a redirect
 *  target is a model the key is served, listed or not. */
export function withRedirectTargets(listed: readonly AiListedModel[], redirects?: AiModelRedirects): readonly AiListedModel[] {
  if (!redirects) return listed;
  const out = [...listed];
  for (const m of listed) {
    const to = redirects[m.id];
    if (!to || out.some((x) => x.id === to)) continue;
    out.push({ id: to, ...(m.vision !== undefined ? { vision: m.vision } : {}) });
  }
  return out;
}

export function versionText(v: readonly number[]): string {
  return v.join(".");
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** The newest model of a family among those listed, or null. */
export function newestOfFamily(catalog: AiModelCatalog, family: string, listed: readonly AiListedModel[], redirects?: AiModelRedirects): string | null {
  let best: { id: string; version: number[] } | null = null;
  for (const m of withRedirectTargets(listed, redirects)) {
    const p = catalog.parse(m.id);
    if (!p || p.family !== family) continue;
    if (!best || compareVersions(p.version, best.version) > 0) best = { id: m.id, version: p.version };
  }
  return best?.id ?? null;
}

export type AiModelResolution =
  | { model: string; latest?: string; retired?: { from: string; family: string } }
  | { model: null; reason: string };

/**
 * The model a call sends, given what the key's listing says.
 *
 * A latest id becomes the newest listed model of its family. An exact id is
 * sent as it is, unless a LIVE listing no longer has it: then it is retired,
 * and the call goes to its family's newest (said once by the caller). A
 * fallback listing never retires anything, because it is only a guess at
 * what the key can use.
 */
export function resolveListedModel(
  catalog: AiModelCatalog,
  model: string,
  listed: readonly AiListedModel[],
  opts: { live: boolean; redirects?: AiModelRedirects },
): AiModelResolution {
  // A model the provider redirects to is served to this key: latest follows
  // it (a redirect to 3.6 makes latest mean 3.6), and a pin on it is not
  // retired for missing from the listing.
  listed = withRedirectTargets(listed, opts.redirects);
  const family = catalog.familyOfLatest(model);
  if (family) {
    const newest = newestOfFamily(catalog, family, listed);
    return newest ? { model: newest, latest: family } : { model: null, reason: `no ${catalog.familyLabel(family)} model is available to this key` };
  }
  const parsed = catalog.parse(model);
  // A provider lists a model under its dated id ("claude-haiku-4-5-20251001")
  // and serves the bare alias too: a pin on either is the same model, still
  // there, never retired and moved.
  const sameModel = (id: string) => {
    if (id === model) return true;
    const other = catalog.parse(id);
    return !!parsed && !!other && other.family === parsed.family && other.version.join(".") === parsed.version.join(".");
  };
  if (!parsed || !opts.live || listed.some((m) => sameModel(m.id))) return { model };
  const newest = newestOfFamily(catalog, parsed.family, listed);
  return newest ? { model: newest, retired: { from: model, family: parsed.family } } : { model };
}

function familyRank(catalog: AiModelCatalog, family: string): [number, string] {
  const i = catalog.familyOrder?.indexOf(family) ?? -1;
  return [i < 0 ? Number.MAX_SAFE_INTEGER : i, family];
}

/** "Haiku 4.5", or the listing's own name for a model outside every family. */
export function modelLabelOf(catalog: AiModelCatalog, id: string, listed?: readonly AiListedModel[], redirects?: AiModelRedirects): string {
  const latest = catalog.familyOfLatest(id);
  if (latest) {
    const newest = listed ? newestOfFamily(catalog, latest, listed, redirects) : null;
    const v = newest ? catalog.parse(newest) : null;
    return `${catalog.familyLabel(latest)} · latest${v ? ` (${versionText(v.version)})` : ""}`;
  }
  const p = catalog.parse(id);
  if (p) return `${catalog.familyLabel(p.family)} ${versionText(p.version)}`;
  return listed?.find((m) => m.id === id)?.label ?? id;
}

/**
 * What a picker for one job offers on one connection: one "latest" entry per
 * family first, then every exact version the key can use for the job, newest
 * first within its family. Only models the listing has and the job's rule
 * accepts; a model the key cannot use never appears.
 */
export function modelChoicesFor(catalog: AiModelCatalog, capability: AiCapability, listed: readonly AiListedModel[], redirects?: AiModelRedirects): AiModelChoice[] {
  const usable = withRedirectTargets(listed, redirects).filter((m) => catalog.canDo(capability, m));
  const redirected = (id: string, label: string, short: string): AiModelChoice => {
    const to = redirects?.[id];
    return to ? { id, label: redirectNote(label, modelLabelOf(catalog, to, listed)), short, redirectsTo: to } : { id, label, short };
  };
  const parsed = usable.map((m) => ({ m, p: catalog.parse(m.id) }));
  const families = [...new Set(parsed.flatMap((x) => (x.p ? [x.p.family] : [])))].sort((a, b) => {
    const [ra, na] = familyRank(catalog, a);
    const [rb, nb] = familyRank(catalog, b);
    return ra - rb || na.localeCompare(nb);
  });
  const latest: AiModelChoice[] = families.map((family) => {
    const resolves = newestOfFamily(catalog, family, usable)!;
    const v = catalog.parse(resolves)!;
    const label = catalog.familyLabel(family);
    return { id: catalog.latestId(family), label: `${label} · latest (${versionText(v.version)})`, short: label, latest: { family, resolves } };
  });
  const pins: AiModelChoice[] = parsed
    .filter((x) => x.p)
    .sort((a, b) => {
      const fa = familyRank(catalog, a.p!.family);
      const fb = familyRank(catalog, b.p!.family);
      return fa[0] - fb[0] || fa[1].localeCompare(fb[1]) || compareVersions(b.p!.version, a.p!.version);
    })
    .map(({ m, p }) => {
      const label = `${catalog.familyLabel(p!.family)} ${versionText(p!.version)}`;
      return redirected(m.id, label, label);
    });
  const other: AiModelChoice[] = parsed.filter((x) => !x.p).map(({ m }) => redirected(m.id, m.label ?? m.id, m.label ?? m.id));
  return [...latest, ...pins, ...other];
}

/** A model id a bench or a recording may name: an exact version, never a
 *  latest id or a provider's floating alias. A bench result is only the
 *  final word on the model it names when that name means one model. */
export function assertPinnedModel(model: string): string {
  if (isFloatingModel(model)) {
    throw new Error(`"${model}" floats to whatever is newest, so a result measured on it says nothing about any one model. Name an exact version.`);
  }
  return model;
}
