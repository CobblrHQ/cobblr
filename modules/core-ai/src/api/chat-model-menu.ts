// What the chat's model pill can offer, and what it is set to.
//
// Two sources, one menu. The workspace's own installed providers, and the
// personal connections routed INTO the workspace and approved (a "Share" the
// owner accepted - the whole connection becomes a workspace connection, which
// is the step the owner named first). Each brings its provider's short list of
// chat models, with a label a person can read and a note on what it costs.
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
  /** "Workspace" or the connection's own name. */
  heading: string;
  /** Whose key this is, for a connection somebody else shared. */
  owner?: "you" | "shared";
  options: MenuOption[];
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
export function modelLabel(prov: MenuProvider | undefined, model: string): { label: string; short: string; note?: string } {
  const n = prov?.modelNotes?.[model];
  if (n) return { label: n.label, short: n.short ?? n.label, ...(n.note ? { note: n.note } : {}) };
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
}): ChatModelMenu {
  const byId = new Map(args.providers.map((p) => [p.id, p]));
  const groups: MenuGroup[] = [];

  // The workspace's own providers, enabled ones only: a disabled provider is
  // a decision somebody made, and the pill must not quietly undo it.
  const ws: MenuOption[] = [];
  for (const row of args.workspace) {
    if (!row.enabled) continue;
    const prov = byId.get(row.provider_id);
    if (!prov || prov.models.length === 0) continue;
    // A model typed on the connection is that connection's whole menu unless
    // the provider curated one: typing a model was a decision too.
    const menu = prov.models.filter((m) => m !== "default");
    const models = menu.length ? menu : row.model ? [row.model] : [];
    for (const m of models) {
      const { label, short, note } = modelLabel(prov, m);
      ws.push({
        key: `ws:${row.provider_id}:${m}`,
        label,
        short,
        ...(note ? { note } : {}),
        choice: { provider_id: row.provider_id, model: m, credential_id: null },
      });
    }
  }
  if (ws.length) groups.push({ heading: "Workspace", options: ws });

  // Personal connections routed here and approved. Yours get their name;
  // somebody else's shared key is "<their share>" without the provider named,
  // which is the same courtesy the AI page extends.
  for (const c of args.routed) {
    if (!c.approved) continue;
    const prov = byId.get(c.providerId);
    if (!prov) continue;
    const menu = prov.models.filter((m) => m !== "default");
    if (menu.length === 0) continue;
    const mine = c.ownerUserId === args.viewerUserId;
    const options: MenuOption[] = menu.map((m) => {
      const { label, short, note } = modelLabel(prov, m);
      return {
        key: `me:${c.credentialId}:${m}`,
        label,
        short,
        ...(note ? { note } : {}),
        choice: { provider_id: null, model: m, credential_id: c.credentialId },
      };
    });
    groups.push({
      heading: mine ? c.label || prov.label : "A shared connection",
      owner: mine ? "you" : "shared",
      options,
    });
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
  const dl = wd ? modelLabel(byId.get(wd.provider_id), wd.model) : null;
  return { groups, current, defaultLabel: dl?.label ?? null, defaultShort: dl?.short ?? "Default" };
}
