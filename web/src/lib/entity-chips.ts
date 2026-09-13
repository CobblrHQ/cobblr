// The records a turn touched, shown as chips you can click, wherever the panel
// names them.
//
// "Created Tazo Tea Wild Sweet Orange." was a sentence in a grey box. The name
// in it is a record that exists now, one click away, and the panel knew its
// id the whole time (the ledger row carries it). Every place the panel names a
// record - a done card, a confirm card, Cobb's own prose - now names it as a
// chip that goes there.
//
// The link is the record's REAL route, written as an ordinary markdown link:
// `[Basmati rice](/inventory/parts/<id>)`. That is how an IDE's chat links a
// file and how a wiki links a page, and it is what makes the text true
// everywhere: a copied transcript keeps a working link, a renderer with no
// chip component shows a plain one, and the markdown sanitiser (which blanks
// any scheme it does not know) has nothing to object to. A private scheme was
// the first draft and failed exactly there.
//
// A chip is then simply "a link whose target is a record's detail route" - the
// renderer recovers the kind by matching the href back against the registry's
// route templates. So a record URL Cobb writes himself becomes a chip too, and
// a link to anything else stays a link.
//
// The server says which records a turn touched or read (kind, id, what a
// person calls it); linkify finds those names in the text and writes the
// link. It is text matching on purpose: the words are already written by the
// module or the model, and a link is only ever put on a name the server
// vouched for. The matching itself is the contract's one rule
// (record-mentions), the same one the server used to decide what to vouch
// for, so the two sides cannot disagree about which words are a record.

import { findRecordNames } from "@cobblr/platform-contract/record-mentions";

export interface ChatEntityRef {
  kind: string;
  id: string;
  label: string;
}

/** Dedupe by kind+id, keeping the first label; drop refs with no id or name. */
export function mergeRefs(...lists: Array<Array<ChatEntityRef | null> | undefined>): ChatEntityRef[] {
  const seen = new Set<string>();
  const out: ChatEntityRef[] = [];
  for (const list of lists) {
    for (const r of list ?? []) {
      if (!r || !r.kind || !r.id || !r.label || r.label.trim().length < 2) continue;
      const key = `${r.kind} ${r.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: r.kind, id: r.id, label: r.label.trim() });
    }
  }
  return out;
}

/** The refs one chat response names: what it applied, what it proposes, and
 *  the records a read answer names (`mentions`: the ones this turn read whose
 *  title the words carry, decided server-side and never invented). */
export function refsOfResponse(r: {
  applied?: Array<{ entity?: { kind: string; id?: string; label?: string }; touched?: ChatEntityRef[] }>;
  proposal?: unknown;
  items?: Array<{ proposal: unknown }>;
  mentions?: ChatEntityRef[];
}): ChatEntityRef[] {
  const fromApplied: ChatEntityRef[] = [];
  for (const a of r.applied ?? []) {
    if (a.entity?.id && a.entity.label) fromApplied.push({ kind: a.entity.kind, id: a.entity.id, label: a.entity.label });
    for (const t of a.touched ?? []) fromApplied.push(t);
  }
  const proposals = [r.proposal, ...(r.items ?? []).map((i) => i.proposal)];
  return mergeRefs(fromApplied, proposals.map(refOfProposal), r.mentions);
}

export function refOfProposal(p: unknown): ChatEntityRef | null {
  if (!p || typeof p !== "object") return null;
  const q = p as { entity_kind?: string; entity_id?: string; entity_label?: string };
  if (!q.entity_kind || !q.entity_id || !q.entity_label) return null;
  return { kind: q.entity_kind, id: q.entity_id, label: q.entity_label };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The text with every vouched-for name that HAS a route turned into a link to
 * it. A name whose kind has no detail page stays prose: there is nowhere to go.
 *
 * The finding is the contract's (findRecordNames): whole words, any case,
 * longest names first so "Tea" inside "Tazo Tea Wild Sweet Orange" cannot
 * split the longer name, existing links stepped over whole, and a title two
 * records share left alone rather than guessed. The link text is the record's
 * own name, or the shortening as written when the words name it by a prefix
 * of its title ("the blue cotton yarn" for Blue cotton yarn 100g 200m). The
 * curly or straight quotes a card puts around a name are absorbed: the chip
 * IS the quoting.
 */
export function linkifyMarkdown(
  text: string,
  refs: ChatEntityRef[],
  routeFor: (kind: string, id: string) => string | null,
): string {
  const linkable = refs.filter((r) => !!r.label && !!routeFor(r.kind, r.id));
  if (linkable.length === 0) return text;
  const spans = findRecordNames(text, linkable);
  let out = text;
  // Back to front, so an earlier span's offsets are still true after a later
  // one has been rewritten.
  for (const s of [...spans].reverse()) {
    const href = routeFor(s.ref.kind, s.ref.id);
    if (!href) continue;
    let { start, end } = s;
    if (/[“"']/.test(text[start - 1] ?? "") && /[”"']/.test(text[end] ?? "")) {
      start -= 1;
      end += 1;
    }
    const shown = s.prefix ? text.slice(s.start, s.end) : s.ref.label;
    out = `${out.slice(0, start)}[${shown}](${href})${out.slice(end)}`;
  }
  return out;
}

/**
 * The vouched-for records a sentence does NOT name, of those with a page: a
 * card about a record whose words leave it out ("✓ Done." after adjusting
 * its stock; the rig, 2026-09-13) shows each of these as a chip after the
 * words, so a result is never a tick with nothing to open.
 */
export function refsLeftUnnamed(
  text: string,
  refs: ChatEntityRef[],
  routeFor: (kind: string, id: string) => string | null,
): ChatEntityRef[] {
  const routed = refs.filter((r) => !!routeFor(r.kind, r.id));
  if (routed.length === 0) return [];
  const named = new Set(findRecordNames(text, routed).map((s) => `${s.ref.kind} ${s.ref.id}`));
  return routed.filter((r) => !named.has(`${r.kind} ${r.id}`));
}

/** A kind, as the registry describes it: `detail_route` is a template such as
 *  `/inventory/parts/{id}`, workspace-relative (the router adds `/w/<slug>`). */
export interface RoutedKind {
  id: string;
  detail_route: string | null;
}

/**
 * Which record a link points at, if it points at one: the href matched back
 * against every registered detail route. Accepts the route bare, with the
 * workspace prefix, or as a same-origin absolute URL, because all three reach
 * the same page and a person (or a model) may write any of them.
 */
export function recordOfHref(
  href: string | undefined,
  kinds: RoutedKind[] | undefined,
): { kind: string; id: string; path: string } | null {
  if (!href || !kinds?.length) return null;
  let path = href;
  if (/^https?:\/\//i.test(path)) {
    try {
      const u = new URL(path);
      // Only this app's own origin is a record link; anywhere else is a link.
      const origin = typeof window !== "undefined" ? window.location.origin : null;
      if (!origin || u.origin !== origin) return null;
      path = u.pathname;
    } catch {
      return null;
    }
  }
  if (!path.startsWith("/")) return null;
  const bare = path.replace(/^\/w\/[^/]+/, "").replace(/[?#].*$/, "");
  for (const k of kinds) {
    const tmpl = k.detail_route;
    if (!tmpl || !tmpl.includes("{id}")) continue;
    const m = new RegExp(`^${escapeRe(tmpl).replace("\\{id\\}", "([^/?#]+)")}$`).exec(bare);
    if (m?.[1]) return { kind: k.id, id: decodeURIComponent(m[1]), path: bare };
  }
  return null;
}
