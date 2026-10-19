// A Bambu printer's live detail: the captured cloud MQTT report, distilled for
// the printer modal (AMS filament slots with colour, material and remaining,
// chamber light, firmware update, HMS error count, temps). The core's detail
// route asks for it through the family's deviceTelemetry hook.
import type { Kysely } from "kysely";
import type { DigifabDB } from "../../../db.js";

function bHex(c: unknown): string | null {
  if (typeof c !== "string" || !/^[0-9a-fA-F]{6,8}$/.test(c)) return null;
  const rgb = c.slice(0, 6).toUpperCase();
  return rgb === "000000" && c.length === 8 && c.slice(6).toUpperCase() === "00" ? null : `#${rgb}`;
}
function bNum(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function bambuTelemetry(db: Kysely<DigifabDB>, connectionId: string, deviceId: string): Promise<{ updated_at: string; telemetry: Record<string, unknown> } | null> {
  const row = await db
    .selectFrom("digifab_bambu_status")
    .select(["report", "updated_at"])
    .where("connection_id", "=", connectionId)
    .where("serial", "=", deviceId)
    .executeTakeFirst();
  if (!row?.report) return null;
  const p = row.report as Record<string, unknown>;
  const slots: { id: string; type: string | null; color: string | null; remain: number | null; brand: string | null }[] = [];
  const amsUnits = Array.isArray((p.ams as { ams?: unknown })?.ams) ? ((p.ams as { ams: Record<string, unknown>[] }).ams) : [];
  for (const unit of amsUnits) {
    const trays = Array.isArray(unit.tray) ? (unit.tray as Record<string, unknown>[]) : [];
    for (const t of trays) {
      if (!t.tray_type) continue; // empty slot
      slots.push({ id: `${unit.id}-${t.id}`, type: (t.tray_type as string) || null, color: bHex(t.tray_color), remain: bNum(t.remain), brand: (t.tray_sub_brands as string) || null });
    }
  }
  const vt = p.vt_tray as Record<string, unknown> | undefined;
  if (vt?.tray_type) slots.push({ id: "ext", type: (vt.tray_type as string) || null, color: bHex(vt.tray_color), remain: bNum(vt.remain), brand: (vt.tray_sub_brands as string) || null });
  const lights = Array.isArray(p.lights_report) ? (p.lights_report as { node?: string; mode?: string }[]) : [];
  const fwList = Array.isArray((p.upgrade_state as { new_ver_list?: unknown })?.new_ver_list) ? ((p.upgrade_state as { new_ver_list: { cur_ver?: string; new_ver?: string }[] }).new_ver_list) : [];
  return {
    updated_at: new Date(row.updated_at).toISOString(),
    telemetry: {
      nozzle: bNum(p.nozzle_temper), nozzle_target: bNum(p.nozzle_target_temper),
      bed: bNum(p.bed_temper), bed_target: bNum(p.bed_target_temper),
      chamber: bNum(p.chamber_temper),
      light: lights.find((l) => l.node === "chamber_light")?.mode ?? null,
      speed_level: bNum(p.spd_lvl),
      nozzle_diameter: (p.nozzle_diameter as string) ?? null,
      nozzle_type: (p.nozzle_type as string) ?? null,
      wifi: (p.wifi_signal as string) ?? null,
      gcode_state: (p.gcode_state as string) ?? null,
      firmware_update: fwList.some((v) => v.new_ver && v.cur_ver && v.new_ver !== v.cur_ver),
      hms_count: Array.isArray(p.hms) ? (p.hms as unknown[]).length : 0,
      ams: slots,
    }
  };
}
