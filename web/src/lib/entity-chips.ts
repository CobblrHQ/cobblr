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
// The server says which records a turn touched (kind, id, what a person calls
// it); linkify finds those names in the text and writes the link. It is text
// matching on purpose: the words are already written by the module or the
// model, and a link is only ever put on a name the server vouched for.

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

/** The refs one chat response names: what it applied, and what it proposes. */
export function refsOfResponse(r: {
  applied?: Array<{ entity?: { kind: string; id?: string; label?: string }; touched?: ChatEntityRef[] }>;
  proposal?: unknown;
  items?: Array<{ proposal: unknown }>;
}): ChatEntityRef[] {
  const fromApplied: ChatEntityRef[] = [];
  for (const a of r.applied ?? []) {
    if (a.entity?.id && a.entity.label) fromApplied.push({ kind: a.entity.kind, id: a.entity.id, label: a.entity.label });
    for (const t of a.touched ?? []) fromApplied.push(t);
  }
  const proposals = [r.proposal, ...(r.items ?? []).map((i) => i.proposal)];
  return mergeRefs(fromApplied, proposals.map(refOfProposal));
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
 * Longest names first in ONE pass, so "Tea" inside "Tazo Tea Wild Sweet
 * Orange" cannot split the longer name, and a name is never re-linked inside
 * a link just written. Existing links are stepped over whole. The curly or
 * straight quotes a card puts around a name are absorbed: the chip IS the
 * quoting.
 */
export function linkifyMarkdown(
  text: string,
  refs: ChatEntityRef[],
  routeFor: (kind: string, id: string) => string | null,
): string {
  const linkable = refs
    .map((r) => ({ ...r, href: routeFor(r.kind, r.id) }))
    .filter((r): r is ChatEntityRef & { href: string } => !!r.label && !!r.href)
    .sort((a, b) => b.label.length - a.label.length);
  if (linkable.length === 0) return text;
  const byLabel = new Map(linkable.map((r) => [r.label, r] as const));
  const names = linkable.map((r) => escapeRe(r.label)).join("|");
  const re = new RegExp(`\\[[^\\]]*\\]\\([^)]*\\)|([“"']?)(${names})([”"']?)`, "g");
  return text.replace(re, (whole: string, _q1: string | undefined, name: string | undefined) => {
    if (!name) return whole;
    const ref = byLabel.get(name)!;
    return `[${ref.label}](${ref.href})`;
  });
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
