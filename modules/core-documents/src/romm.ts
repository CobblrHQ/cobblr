// RomM (romm.app, a self-hosted retro game library) as a library of games:
// library.find and library.get, spoken in RomM's own REST API.
//
// The second library after Paperless, and the probe for whether the adapter
// pattern is general (#4489): a physical cartridge or disc in Cobblr links to
// its ROM in RomM, matched by IGDB id when the record has one, else by title
// and platform. Everything RomM-shaped is in this file.
//
// It offers no library.link (RomM has no field to keep a Cobblr address in)
// and no library.copy (a ROM can be gigabytes, and is RomM's to keep), so the
// record's panel draws neither button for it.
//
// Auth is a RomM Client API Token (Administration → Client API tokens,
// `rmm_…`), sent as a Bearer token: the mode RomM recommends for a
// long-lived integration. Like every adapter, it reaches RomM only through
// ctx.fetch, directly or through the person's bridge.

import type { AdapterResponse, BuiltInConnectionDef, BuiltInServiceContext, BuiltInServiceDef } from "@cobblr/platform-contract/services";
import { ADAPTER_TRANSIT_PROPERTY } from "@cobblr/platform-contract/services";
import { platform } from "@cobblr/platform-contract";
import {
  LIBRARY_CAPABILITY_DECLS,
  LIBRARY_FIND,
  LIBRARY_GET,
  type LibraryFindInput,
  type LibraryGetInput,
  type LibraryItem,
  type RecordFacts,
} from "@cobblr/platform-contract/library";

export const ROMM_GROUP = "romm";
const COVER_MAX = 400 * 1024;

const connection: BuiltInConnectionDef = {
  title: "RomM",
  summary: "Your retro game library, linked to the cartridges and discs on your shelf. Cobblr links to each game in RomM; nothing is copied.",
  group: ROMM_GROUP,
  config_schema: {
    type: "object",
    properties: {
      base_url: { type: "string", title: "Address", format: "uri", description: "Where RomM answers, e.g. http://192.168.1.30:8080" },
      token: { type: "string", title: "Client API token", writeOnly: true, description: "In RomM: Administration, Client API tokens. It starts with rmm_." },
      transit: ADAPTER_TRANSIT_PROPERTY,
    },
    required: ["base_url", "token"],
  },
  async test(config, ctx) {
    if (!ctx.fetch) return { ok: false, reason: "unreachable", error: "Give the address RomM answers at." };
    const started = Date.now();
    let res: AdapterResponse;
    try {
      res = await ctx.fetch({ path: "/api/roms?limit=1&with_total=true", headers: auth(config) });
    } catch (err) {
      return { ok: false, reason: "unreachable", error: `RomM did not answer: ${plainError(err)}` };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, reason: "invalid_key", error: "RomM did not accept this token. Make a Client API token in RomM's Administration and paste it here." };
    if (res.status >= 500) return { ok: false, reason: "busy", error: `RomM answered ${res.status}.` };
    const body = res.json as { items?: unknown; total?: unknown } | null;
    if (res.status !== 200 || !Array.isArray(body?.items)) return { ok: false, reason: "unknown", error: `That address answered ${res.status}, not like RomM does.` };
    const total = typeof body?.total === "number" ? body.total : null;
    // Connected, and nothing to link to yet, is not a failure; it is said in
    // the same line, so a person is not left wondering why nothing matches.
    if (total === 0) return { ok: true, note: `RomM answered in ${Date.now() - started} ms, but its library has no games yet` };
    return { ok: true, note: `RomM${total != null ? `, ${total} game${total === 1 ? "" : "s"}` : ""}, answered in ${Date.now() - started} ms` };
  },
};

function auth(config: Record<string, string> | undefined): Record<string, string> {
  return { authorization: `Bearer ${config?.token ?? ""}`, accept: "application/json" };
}

/** An error in words a person can read, never a header or a body. */
function plainError(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.replace(/Bearer\s+\S+/gi, "Bearer [hidden]").replace(/rmm_[0-9a-f]+/gi, "[hidden]").slice(0, 200);
}

async function call(ctx: BuiltInServiceContext, path: string): Promise<AdapterResponse> {
  if (!ctx.fetch || !ctx.config) throw new Error("This RomM connection has no address.");
  const res = await ctx.fetch({ path, headers: auth(ctx.config) });
  if (res.status === 401 || res.status === 403) throw new Error("RomM did not accept the token on this connection.");
  if (res.status === 404) throw new Error("RomM has no such game.");
  if (res.status >= 400) throw new Error(`RomM answered ${res.status}.`);
  return res;
}

interface RommRom {
  id: number;
  name?: string | null;
  fs_name_no_tags?: string | null;
  fs_name?: string | null;
  igdb_id?: number | null;
  platform_id?: number;
  platform_slug?: string | null;
  platform_display_name?: string | null;
  path_cover_small?: string | null;
  url_cover?: string | null;
  summary?: string | null;
  metadatum?: { first_release_date?: number | null } | null;
}
interface RommPlatform {
  id: number;
  name?: string;
  display_name?: string;
  custom_name?: string | null;
  slug?: string;
  fs_slug?: string;
}

/** Platforms RomM plays in the browser (its EmulatorJS cores), by RomM's
 *  platform slug: a game on one of these is playable in RomM, which is worth
 *  saying on a cartridge you cannot plug in anywhere any more. */
const PLAYABLE = new Set([
  "nes", "famicom", "snes", "sfam", "n64", "gb", "gbc", "gba", "nds", "virtualboy",
  "sms", "genesis-slash-megadrive", "gamegear", "sega-cd", "sega32", "saturn",
  "atari2600", "atari5200", "atari7800", "lynx", "jaguar", "ps", "psp",
  "turbografx16--1", "neo-geo-pocket", "neo-geo-pocket-color", "wonderswan", "wonderswan-color",
  "colecovision", "3do", "arcade",
]);

/** The short names people write on a box or a shelf label, by RomM's
 *  platform slug, so "SNES" on a cartridge agrees with RomM's "Super Nintendo
 *  Entertainment System". */
const PLATFORM_SHORT: Record<string, string[]> = {
  snes: ["SNES", "Super Nintendo", "Super Famicom"],
  nes: ["NES", "Nintendo", "Famicom"],
  n64: ["N64", "Nintendo 64"],
  gb: ["GB", "Game Boy"],
  gbc: ["GBC", "Game Boy Color"],
  gba: ["GBA", "Game Boy Advance"],
  nds: ["DS", "NDS", "Nintendo DS"],
  "genesis-slash-megadrive": ["Genesis", "Mega Drive", "Megadrive"],
  sms: ["Master System", "SMS"],
  ps: ["PS1", "PSX", "PlayStation"],
  ps2: ["PS2", "PlayStation 2"],
  psp: ["PSP"],
};

function squash(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The record's platform, from whichever of its short fields names one. */
function platformWords(facts: RecordFacts | undefined): string | null {
  for (const [k, v] of Object.entries(facts?.fields ?? {})) if (/^(platform|console|system)$/i.test(k) && v.trim()) return v.trim();
  return null;
}

/** The RomM platforms a record's platform words name ("SNES", "Super
 *  Nintendo", "snes"), by display name, name, custom name or slug. */
async function platformIds(ctx: BuiltInServiceContext, words: string): Promise<number[]> {
  const all = ((await call(ctx, "/api/platforms")).json as RommPlatform[] | null) ?? [];
  const want = squash(words);
  if (!want) return [];
  return all
    .filter((p) => [p.display_name, p.name, p.custom_name, p.slug, p.fs_slug].some((n) => {
      const have = squash(n);
      return !!have && (have === want || (want.length >= 4 && (have.includes(want) || want.includes(have))));
    }))
    .map((p) => p.id);
}

function baseOf(ctx: BuiltInServiceContext): string {
  return (ctx.config?.base_url ?? "").trim().replace(/\/+$/, "");
}

function itemOf(r: RommRom, base: string, facts?: RecordFacts, platformMatched = false): LibraryItem {
  const title = (r.name || r.fs_name_no_tags || r.fs_name || `Game ${r.id}`).slice(0, 500);
  const released = r.metadatum?.first_release_date;
  // The same IGDB id on the record is the shared rule's to see (ids, below),
  // in both directions; what only this search knows is that it was scoped
  // to the record's platform.
  const match: LibraryItem["match"] = facts && platformMatched && squash(title) === squash(facts.name) ? { score: 0.9, because: "title and platform" } : null;
  return {
    ref: String(r.id),
    type: "game",
    type_label: "Games",
    title,
    subtitle: r.platform_display_name ?? null,
    created: typeof released === "number" && released > 0 ? new Date(released).toISOString().slice(0, 10) : null,
    tags: r.platform_slug && PLAYABLE.has(r.platform_slug) ? ["Playable in RomM"] : [],
    open_url: base ? `${base}/rom/${r.id}` : null,
    open_label: "Open in RomM",
    has_thumb: !!(r.path_cover_small || r.url_cover),
    ...(r.summary ? { excerpt: r.summary.slice(0, 2000) } : {}),
    ...(r.igdb_id ? { ids: { igdb: String(r.igdb_id) } } : {}),
    // What a cartridge's own platform field may call it: the shared rule
    // keeps an SNES cartridge off the Game Boy Advance port, in both
    // directions (a search and the daily catch-up alike).
    ...(r.platform_display_name || r.platform_slug ? { attributes: { platform: [r.platform_display_name, r.platform_slug, ...(PLATFORM_SHORT[r.platform_slug ?? ""] ?? [])].filter((n): n is string => !!n) } } : {}),
    match,
  };
}

/** The words of a record's name worth searching RomM for: without the
 *  platform the person may have written into it ("Zelda (SNES)"). */
function searchWords(name: string, platform: string | null): string {
  let s = name.replace(/[([][^)\]]*[)\]]/g, " ");
  if (platform) s = s.replace(new RegExp(platform.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), " ");
  return s.replace(/\s+/g, " ").trim();
}

const find: BuiltInServiceDef = {
  id: "romm.find",
  name: "RomM",
  capability: LIBRARY_CAPABILITY_DECLS[LIBRARY_FIND],
  connection,
  async run(ctx) {
    const input = (ctx.input ?? {}) as LibraryFindInput;
    const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
    const offset = Math.max(0, Number(input.cursor) || 0);
    const base = baseOf(ctx);
    const page = async (params: string): Promise<{ items: RommRom[]; total: number | null }> => {
      const body = (await call(ctx, `/api/roms?${params}&limit=${limit}&offset=${offset}&with_total=true`)).json as { items?: RommRom[]; total?: number | null } | null;
      return { items: body?.items ?? [], total: typeof body?.total === "number" ? body.total : null };
    };
    const nextOf = (got: { items: RommRom[]; total: number | null }) =>
      got.items.length === limit && (got.total == null || offset + limit < got.total) ? String(offset + limit) : null;

    if (typeof input.query === "string" && input.query.trim()) {
      const got = await page(`search_term=${encodeURIComponent(input.query.trim())}`);
      return { output: { items: got.items.map((r) => itemOf(r, base, input.facts)), next: nextOf(got) } };
    }
    if (input.since) {
      // What changed since the last look, newest first: RomM has no webhook,
      // so the daily catch-up is how a newly scanned ROM finds its cartridge.
      const got = await page(`updated_after=${encodeURIComponent(input.since)}&order_by=updated_at&order_dir=desc`);
      return { output: { items: got.items.map((r) => itemOf(r, base)), next: nextOf(got) } };
    }
    const facts = input.facts;
    const platformText = platformWords(facts);
    const ids = platformText ? await platformIds(ctx, platformText) : [];
    const words = searchWords(facts?.name ?? "", platformText);
    if (!words) return { output: { items: [] } };
    const scope = ids.map((id) => `&platform_ids=${id}`).join("");
    let got = await page(`search_term=${encodeURIComponent(words)}${scope}`);
    // A platform the record names that RomM calls something else: the title
    // alone, and the platform no longer counts as evidence.
    const scoped = ids.length > 0 && got.items.length > 0;
    if (ids.length && !got.items.length) got = await page(`search_term=${encodeURIComponent(words)}`);
    return { output: { items: got.items.map((r) => itemOf(r, base, facts, scoped)) } };
  },
};

const get: BuiltInServiceDef = {
  id: "romm.get",
  name: "RomM",
  capability: LIBRARY_CAPABILITY_DECLS[LIBRARY_GET],
  connection,
  async run(ctx) {
    const input = (ctx.input ?? {}) as LibraryGetInput;
    const id = Number(String(input.ref ?? "").trim());
    if (!Number.isInteger(id) || id <= 0) throw new Error("That is not a RomM game.");
    const rom = (await call(ctx, `/api/roms/${id}`)).json as RommRom | null;
    if (!rom || typeof rom.id !== "number") throw new Error("RomM answered without the game.");
    let thumb: { type: string; base64: string } | null = null;
    // The cover RomM keeps itself; an outside url_cover is IGDB's, which this
    // server would have to fetch on its own, so only RomM's copy is used.
    if (input.include === "thumb" && rom.path_cover_small && rom.path_cover_small.startsWith("/")) {
      try {
        const res = await call(ctx, rom.path_cover_small.split("?")[0]!);
        if (res.bytes.byteLength && res.bytes.byteLength <= COVER_MAX) {
          thumb = { type: (res.headers["content-type"] ?? "image/webp").split(";")[0]!.trim(), base64: Buffer.from(res.bytes).toString("base64") };
        }
      } catch {
        thumb = null;
      }
    }
    return { output: { item: itemOf(rom, baseOf(ctx)), thumb } };
  },
};

export const ROMM_BUILT_INS: BuiltInServiceDef[] = [find, get];

let registered = false;
export function registerRomm(): void {
  if (registered) return;
  registered = true;
  for (const def of ROMM_BUILT_INS) platform().services.registerBuiltIn(def);
}
