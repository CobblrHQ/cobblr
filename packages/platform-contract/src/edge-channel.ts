// How a bridge is addressed: one derivation of the edge channel key, for the
// side that registers a bridge and every side that sends to one.
//
// The key is `<orgId>` for a workspace's default bridge, `<orgId>::<name>` for a
// named one, and the owner's user id for a personal bridge (one bridge serving
// all of a person's workspaces). It was derived in seven places: the kernel's
// relay door and presence read, digifab's relay alias and its job sender,
// core-print, core-integrations' sync fetch, the AI and shipments transits. The
// receiving doors capped a bridge name at 60 characters; core-print's sender
// trimmed it and did not cap, and the rest did neither. A bridge whose name ran
// past 60 characters, or carried a space, registered on one key and was sent to
// on another, and a send to a channel nobody holds reads exactly like a bridge
// that is offline (#3421, #3499).
//
// Every door now derives the key here, so the name is normalised the same way
// on both ends of the wire.

/** The longest bridge name a key carries; longer names are cut, the same way on
 *  every side. */
export const EDGE_BRIDGE_NAME_MAX = 60;

/** A bridge name as it appears in a key: trimmed, capped, or null for the
 *  workspace's default bridge. Accepts whatever a query string or a setting
 *  hands over. */
export function edgeBridgeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().slice(0, EDGE_BRIDGE_NAME_MAX).trim();
  return name || null;
}

/** A workspace bridge's channel key: `<orgId>`, or `<orgId>::<name>`. */
export function edgeChannelKey(orgId: string, bridge?: unknown): string {
  const name = edgeBridgeName(bridge);
  return name ? `${orgId}::${name}` : orgId;
}

/** A transit setting shared by connections that can go through a bridge:
 *  "" or absent means direct, "bridge" the default bridge, "bridge:<name>" a
 *  named one. */
export function edgeTransit(raw: unknown): { viaBridge: boolean; bridge: string | null } {
  const t = typeof raw === "string" ? raw.trim() : "";
  if (!t.startsWith("bridge")) return { viaBridge: false, bridge: null };
  return { viaBridge: true, bridge: t.startsWith("bridge:") ? edgeBridgeName(t.slice("bridge:".length)) : null };
}

/** The key a send routes to: the owner's personal bridge when the connection
 *  belongs to a person, else the workspace's (default or named). Throws when
 *  there is neither, because a send with no route cannot be answered. */
export function edgeRouteKey(route: { ownerUserId?: unknown; orgId?: unknown; bridge?: unknown }): string {
  const owner = typeof route.ownerUserId === "string" ? route.ownerUserId.trim() : "";
  if (owner) return owner;
  const org = typeof route.orgId === "string" ? route.orgId : "";
  if (!org) throw new Error("edge: no personal owner or workspace to route to a bridge");
  return edgeChannelKey(org, route.bridge);
}

/** A bridge's API token is named after the bridge, with this in front so the
 *  token list says what each token is for. */
const BRIDGE_TOKEN_PREFIX = "Edge bridge: ";

/** The name to give the API token a bridge will install with. */
export function bridgeTokenName(bridgeName: string): string {
  return `${BRIDGE_TOKEN_PREFIX}${bridgeName.trim() || "bridge"}`;
}

/** The bridge's own name, read back from its token's name: what the person
 *  typed on the setup screen. Null for a token that was not minted for a
 *  bridge, so an unrelated token never names one. */
export function bridgeNameFromToken(tokenName: string | null | undefined): string | null {
  if (!tokenName || !tokenName.startsWith(BRIDGE_TOKEN_PREFIX)) return null;
  const name = tokenName.slice(BRIDGE_TOKEN_PREFIX.length).trim();
  return name && name !== "bridge" ? name : null;
}

/** The one line that installs a bridge on Linux, macOS or a Raspberry Pi with a
 *  pairing code: the script comes from this Cobblr and trades the code for the
 *  bridge's token on the box, so no token is ever pasted. */
export function bridgeOneLineInstall(origin: string, code: string): string {
  return `curl -fsSL ${origin.replace(/\/+$/, "")}/api/v1/edge/install.sh | sh -s -- ${code}`;
}

/** The copy-ready commands that install a tunnel bridge: `docker run` and a
 *  compose file. One builder, because every setup screen hands out the same
 *  install and a line added to one copy (the host's name, say) silently
 *  missed the other.
 *
 *  Registry-free: a stock public node image fetches the bridge code from this
 *  Cobblr (loader, then a sha-verified bundle) with the tunnel token, and
 *  restarts onto new versions by itself. The shell reads the token and URL
 *  from its environment, so the secret is never in argv or shell history;
 *  `|| true` keeps a cached loader usable when the cloud blips on a restart.
 *  `--hostname "$(hostname)"` makes the bridge report the box's own name
 *  instead of the container's random id. Compose has no portable way to read
 *  the host's name, so there the bridge reports none rather than a guess. */
export function bridgeInstallCommands(opts: { relayUrl: string; token: string; bridgeId?: string | null }): {
  run: string;
  compose: string;
} {
  const { relayUrl, token } = opts;
  const bid = opts.bridgeId?.trim() || null;
  const shellCmd =
    'wget -qO loader.mjs --header "Authorization: Bearer $BRIDGE_RELAY_TOKEN" "$BRIDGE_RELAY_URL/release/loader" || true; node loader.mjs';
  // docker run: single-quote for the HOST shell so $ survives to the container.
  const runCmd = `sh -c '${shellCmd}'`;
  // compose: list-form command (a colon inside a plain scalar breaks YAML) and
  // $$ so compose's own interpolation leaves the $ for the container shell.
  const composeCmd = `command: ["sh", "-c", "${shellCmd.replace(/\$/g, "$$$$").replace(/"/g, '\\"')}"]`;
  const run = [
    "docker run -d --name cobblr-edge-bridge --restart unless-stopped \\",
    '  --hostname "$(hostname)" \\',
    "  -v cobblr-bridge-data:/data -w /data \\",
    "  -e BRIDGE_MODE=tunnel \\",
    `  -e BRIDGE_RELAY_URL=${relayUrl} \\`,
    `  -e BRIDGE_RELAY_TOKEN=${token} \\`,
    ...(bid ? [`  -e BRIDGE_ID=${bid} \\`] : []),
    "  node:22-alpine \\",
    `  ${runCmd}`,
  ].join("\n");
  const compose = [
    "# docker-compose.yml, then: docker compose up -d",
    "# Self-updating: the bridge fetches its own code from your Cobblr (sha-verified)",
    "# and restarts onto new versions. Stock node image, nothing else to pull.",
    "services:",
    "  cobblr-edge-bridge:",
    "    image: node:22-alpine",
    "    restart: unless-stopped",
    "    working_dir: /data",
    "    volumes:",
    "      - ./bridge-data:/data",
    "    environment:",
    "      BRIDGE_MODE: tunnel",
    `      BRIDGE_RELAY_URL: ${relayUrl}`,
    `      BRIDGE_RELAY_TOKEN: ${token}`,
    ...(bid ? [`      BRIDGE_ID: ${bid}`] : []),
    `    ${composeCmd}`,
  ].join("\n");
  return { run, compose };
}

/** What a person calls a bridge: the name it was given (at setup, when it was
 *  installed, or set since). A bridge from before names reads as "Your bridge"
 *  when it is the workspace's first, or by the id it was installed with. Never
 *  the word "default", never "main". One rule, so a notice from the server and
 *  the page it links to say the same name. */
export function bridgeDisplayName(b: { bridge: string | null; name?: string | null }): string {
  if (b.name && b.name.trim()) return b.name.trim();
  return b.bridge === null ? "Your bridge" : b.bridge;
}

/** What a registering bridge says about itself: its version, its machine, and
 *  (only when it reports one) the addresses it will reach. One reading for
 *  every door a bridge registers through, so a field added to the report is
 *  never learned by one door and missed by the other. */
export function parseBridgeReport(
  body: unknown,
  tokenId: string | null,
): { version: string | null; hostname: string | null; tokenId: string | null; allow?: string[] | null; features?: string[] | null } {
  const b = (body && typeof body === "object" ? body : {}) as { version?: unknown; hostname?: unknown; allow?: unknown; features?: unknown };
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((e): e is string => typeof e === "string") : null);
  return {
    version: typeof b.version === "string" ? b.version : null,
    hostname: typeof b.hostname === "string" ? b.hostname : null,
    tokenId,
    ...("allow" in b ? { allow: strings(b.allow) } : {}),
    // What the bridge can do (abort, headers, lanes, scope, …). A bridge from
    // before this reports nothing, and is treated as having none of them.
    ...("features" in b ? { features: strings(b.features)?.slice(0, 32).map((f) => f.slice(0, 40)) ?? null } : {}),
  };
}

/** Which lane a call runs in on a bridge, when the caller did not say: a
 *  machine call is device status, a source call is sync, anything else is AI.
 *  The one rule, for the queue and for anything that reports on it. */
export function edgeLaneOf(req: { lane?: string | null; instance?: unknown; source?: unknown }): "device" | "control" | "service" | "ai" | "sync" {
  const l = req.lane;
  if (l === "device" || l === "control" || l === "service" || l === "ai" || l === "sync") return l;
  if (req.instance) return "device";
  if (req.source) return "sync";
  return "ai";
}

const LANE_WORDS = ["device", "control", "service", "ai", "sync"] as const;

/** The lanes a polling bridge says have a free slot (`?lanes=device,control`),
 *  or null when it names none (an older bridge: hand it anything). Every door
 *  a bridge polls reads it here. */
export function parsePollLanes(raw: unknown): Array<(typeof LANE_WORDS)[number]> | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const lanes = raw.split(",").map((l) => l.trim()).filter((l): l is (typeof LANE_WORDS)[number] => (LANE_WORDS as readonly string[]).includes(l));
  return lanes.length ? [...new Set(lanes)] : null;
}

/** A bridge's answer to one relayed call, as every /respond door reads it.
 *  Null when it is not one (no id, no numeric status). Headers are kept only
 *  as strings, a few, short. */
export function parseRelayResponse(raw: unknown): { id: string; status: number; body?: unknown; headers?: Record<string, string> } | null {
  const b = (raw && typeof raw === "object" ? raw : {}) as { id?: unknown; status?: unknown; body?: unknown; headers?: unknown };
  if (typeof b.id !== "string" || !b.id || typeof b.status !== "number" || !Number.isInteger(b.status)) return null;
  let headers: Record<string, string> | undefined;
  if (b.headers && typeof b.headers === "object") {
    headers = {};
    for (const [k, v] of Object.entries(b.headers as Record<string, unknown>).slice(0, 16)) {
      if (typeof v === "string") headers[k.toLowerCase().slice(0, 64)] = v.slice(0, 512);
    }
  }
  return { id: b.id, status: b.status, ...("body" in b ? { body: b.body } : {}), ...(headers ? { headers } : {}) };
}
