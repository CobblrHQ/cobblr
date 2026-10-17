// Show units as symbols or names (core-units:set-display-mode): the handler its manifest entry names. Wired in ./index.ts.
// The same write as the display choice on /configuration/units (PUT /units/settings).
import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { CoreUnitsDB } from "../db.js";
import { DISPLAY_MODES, writeDisplayMode, type DisplayMode } from "./units.js";

const WORDS: Record<string, DisplayMode> = { symbol: "symbol", symbols: "symbol", name: "name", names: "name", "full names": "name", both: "both" };
const SHOWS: Record<DisplayMode, string> = { symbol: "symbols (3 kg)", name: "names (3 kilograms)", both: "both (3 kg, kilograms)" };

export function registerSetDisplayModeAction(): void {
  platform().actions.registerHandler("core-units.set-display-mode", async (ctx) => {
    const raw = typeof ctx.args?.display_mode === "string" ? ctx.args.display_mode.trim().toLowerCase() : "";
    const mode = WORDS[raw];
    if (!mode) return { ok: false, error: `Say one of ${DISPLAY_MODES.join(", ")}.` };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CoreUnitsDB>;
    const before = ((await db.selectFrom("core_units_settings").select("display_mode").where("id", "=", 1).executeTakeFirst())?.display_mode ?? "symbol") as DisplayMode;
    await writeDisplayMode(db, mode);
    return { ok: true, summary: `Units now show as ${SHOWS[mode]}.`, data: { display_mode: mode, before } };
  });
  platform().actions.registerUndo("core-units.set-display-mode", (result) => {
    const d = (result as { ok?: unknown; data?: { display_mode?: string; before?: string } } | null);
    if (d?.ok !== true || !d.data?.before || d.data.before === d.data.display_mode) return null;
    return { action_id: "core-units:set-display-mode", args: { display_mode: d.data.before } };
  });
}
