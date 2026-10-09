// What the chat's model pill can offer, and what it is set to.
//
// Two sources, one menu. The workspace's own installed providers, and the
// personal connections that can answer THIS person here: their own, "Just me"
// ones included, and a Share the owner accepted. The route reads that set from
// the router's own walk (platform().ai.chainFor, #3842), so the menu offers
// exactly the connections a chat could reach, in the order it would ask them.
// Picking one pins this person's chat to it; nothing else's order changes. Each brings its provider's short list of
// chat models, with a label a person can read and a note on what it costs.
//
// A connection whose models depend on its endpoint (an Ollama, a self-hosted
// OpenAI-compatible server, a bridge) offers what it REPORTS, asked of it
// (platform().ai.modelsReportedBy), never its type's suggestions: a Claude
// bridge listed llama3.2 and qwen2.5 it did not have (#4586). One that cannot
// be asked says so, with a Retry, rather than guessing.
//
// Pure: given the pieces, returns the menu. The route fetches the pieces.

export interface MenuProvider {
  id: string;
  label: string;
  models: string[];
  defaultModel?: string;
  modelNotes?: Record<string, { label: string; note?: string; short?: string }>;
}

export interface WorkspaceProviderRow {
  provider_id: string;
  label: string;
  enabled: boolean;
  /** The connection's own model field, when one was typed. */
  model?: string | null;
}

export interface RoutedConnection {
  credentialId: string;
  providerId: string;
  label: string;
  ownerUserId: string;
  approved: boolean;
  active: boolean;
}

export interface ModelChoice {
  provider_id?: string | null;
  model?: string | null;
  credential_id?: string | null;
}

export interface MenuOption {
  /** Stable key for the pill: "ws:<provider>:<model>" or "me:<credential>:<model>". */
  key: string;
  label: string;
  /** What the pill shows at rest: the label, cut to what fits beside two other
   *  chips on one row. "Flash Lite", not "Gemini Flash Lite". */
  short: string;
  note?: string;
  /** What to write to prefs when picked. */
  choice: { provider_id: string | null; model: string; credential_id: string | null };
}

export interface MenuGroup {
  /** "ws" for the workspace's own providers, else the connection's credential
   *  id: what the router's order and a Retry name it by. */
  key: string;
  /** "Workspace" or the connection's own name. */
  heading: string;
  /** Whose key this is, for a connection somebody else shared. */
  owner?: "you" | "shared";
  options: MenuOption[];
  /** The connection could not be asked what it serves: the menu says so and
   *  offers a Retry instead of options it would be guessing. */
  unlisted?: { error: string };
}

/** What a connection reported, by group key: "ws:<provider_id>" for the
 *  workspace's own, the credential id for a personal one. */
export type ReportedModels = Record<
  string,
  | { ok: true; models: string[]; choices?: Array<{ id: string; label: string; short: string; latest?: { family: string; resolves: string } }>; fallback?: string }
  | { ok: false; error: string; models?: string[] }
>;

/** A reported model's words: the connection's own entry when it gave one
 *  ("Haiku · latest (5.5)", short "Haiku"), else the label rule below. */
function reportedLabel(prov: MenuProvider | undefined, live: ReportedModels[string] | undefined, model: string): { label: string; short: string; note?: string } {
  const choice = live?.ok ? live.choices?.find((c) => c.id === model) : undefined;
  if (choice) return { label: choice.label, short: choice.short, ...(choice.latest ? { note: "moves to each new version" } : {}) };
  return modelLabel(prov, model, { asReported: !!live });
}

export interface ChatModelMenu {
  groups: MenuGroup[];
  /** The option currently in force, or null when the workspace default applies. */
  current: MenuOption | null;
  /** What "workspace default" means right now, as a label, for the "back to
   *  default" row; null when it cannot be worked out. */
  defaultLabel: string | null;
  /** ...and as the pill shows it at rest. "Default" when unknown: the pill
   *  has one row to live on and "Workspace default" wrapped it. */
  defaultShort: string;
}

/** The label for a model id: the provider's note, else a tidied id. `short` is
 *  what fits on the pill: the note's own, else the label, else the id. */
export function modelLabel(prov: MenuProvider | undefined, model: string, opts: { asReported?: boolean } = {}): { label: string; short: string; note?: string } {
  const n = prov?.modelNotes?.[model];
  if (n) return { label: n.label, short: n.short ?? n.label, ...(n.note ? { note: n.note } : {}) };
  // A name the connection reported is the name the person pulled or typed
  // ("muse-glimmer:latest"): shown exactly, so it matches what they know.
  if (opts.asReported) return { label: model, short: model };
  // "gemini-flash-lite-latest" -> "gemini flash lite latest": readable, and
  // honest that nobody wrote a nicer name for it.
  const label = model.replace(/^models\//, "").replace(/[-_]+/g, " ");
  return { label, short: label };
}

export function chatModelMenu(args: {
  providers: MenuProvider[];
  workspace: WorkspaceProviderRow[];
  routed: RoutedConnection[];
  viewerUserId: string;
  prefs: ModelChoice;
  /** What the workspace's own chat default resolves to, when known. */
  workspaceDefault?: { provider_id: string; model: string } | null;
  /** The order the groups are asked in: "ws" for the workspace's own
   *  providers, a credential id for a connection. Unlisted groups keep their
   *  place after the listed ones. */
  order?: string[];
  /** What each connection that can be asked reported. A connection absent
   *  here keeps its provider's curated list. */
  reported?: ReportedModels;
}): ChatModelMenu {
  const byId = new Map(args.providers.map((p) => [p.id, p]));
  const groups: MenuGroup[] = [];

  // The workspace's own providers, enabled ones only: a disabled provider is
  // a decision somebody made, and the pill must not quietly undo it.
  const ws: MenuOption[] = [];
  const wsUnlisted: string[] = [];
  for (const row of args.workspace) {
    if (!row.enabled) continue;
    const prov = byId.get(row.provider_id);
    if (!prov) continue;
    const live = args.reported?.[`ws:${row.provider_id}`];
    if (live && !live.ok) wsUnlisted.push(`${row.label || prov.label}: ${live.error}`);
    // A model typed on the connection is that connection's whole menu unless
    // the provider curated one: typing a model was a decision too.
    const menu = live ? (live.models ?? []) : prov.models.filter((m) => m !== "default");
    const models = menu.length ? menu : row.model ? [row.model] : [];
    for (const m of models) {
      const { label, short, note } = reportedLabel(prov, live, m);
      ws.push({
        key: `ws:${row.provider_id}:${m}`,
        label,
        short,
        ...(note ? { note } : {}),
        choice: { provider_id: row.provider_id, model: m, credential_id: null },
      });
    }
  }
  if (ws.length || wsUnlisted.length) {
    groups.push({ key: "ws", heading: "Workspace", options: ws, ...(wsUnlisted.length ? { unlisted: { error: wsUnlisted.join(" ") } } : {}) });
  }

  // Personal connections routed here and approved. Yours get their name;
  // somebody else's shared key is "<their share>" without the provider named,
  // which is the same courtesy the AI page extends.
  for (const c of args.routed) {
    if (!c.approved) continue;
    const prov = byId.get(c.providerId);
    if (!prov) continue;
    const live = args.reported?.[c.credentialId];
    const menu = live ? (live.models ?? []) : prov.models.filter((m) => m !== "default");
    if (menu.length === 0 && !(live && !live.ok)) continue;
    const mine = c.ownerUserId === args.viewerUserId;
    const options: MenuOption[] = menu.map((m) => {
      const { label, short, note } = reportedLabel(prov, live, m);
      return {
        key: `me:${c.credentialId}:${m}`,
        label,
        short,
        ...(note ? { note } : {}),
        choice: { provider_id: null, model: m, credential_id: c.credentialId },
      };
    });
    groups.push({
      key: c.credentialId,
      heading: mine ? c.label || prov.label : "A shared connection",
      owner: mine ? "you" : "shared",
      options,
      ...(live && !live.ok ? { unlisted: { error: live.error } } : {}),
    });
  }

  if (args.order?.length) {
    const rank = (g: MenuGroup): number => {
      const i = args.order!.indexOf(g.key);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    groups.sort((a, b) => rank(a) - rank(b));
  }

  // What is in force. A pref that names something no longer on the menu
  // (a provider disabled since, a share withdrawn) falls back to the default
  // rather than pinning the chat to a thing that cannot answer.
  const all = groups.flatMap((g) => g.options);
  let current: MenuOption | null = null;
  if (args.prefs.credential_id && args.prefs.model) {
    current = all.find((o) => o.choice.credential_id === args.prefs.credential_id && o.choice.model === args.prefs.model) ?? null;
  } else if (args.prefs.provider_id && args.prefs.model) {
    current = all.find((o) => o.choice.provider_id === args.prefs.provider_id && o.choice.model === args.prefs.model) ?? null;
  }

  const wd = args.workspaceDefault;
  // A default the menu itself offers reads as the menu does ("Haiku · latest
  // (5.5)"), not as its id.
  const offered = wd ? all.find((o) => o.choice.model === wd.model) : undefined;
  const dl = offered ? { label: offered.label, short: offered.short } : wd ? modelLabel(byId.get(wd.provider_id), wd.model) : null;
  return { groups, current, defaultLabel: dl?.label ?? null, defaultShort: dl?.short ?? "Default" };
}
