import type { Kysely } from "kysely";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { ArmCommandSchema, armCommandRefusal, type ArmCommand, type ArmCommandResult, type ArmState } from "@cobblr/platform-contract/robot-arm";
import type { DigifabDB } from "../../db.js";
import { authorizeArm, ArmRefusal, type ArmPermit } from "./station.js";
import { ownershipRefusal } from "./rules.js";
import { armDriver, machineRef, requireUnit } from "./store.js";
export const ArmCommandInput = z.object({ command: ArmCommandSchema, station_token: z.string().min(32).max(128).optional() });
export interface ArmActor { userId: string | null; via: "page" | "station" | "assistant"; operate: boolean; admin: boolean }
const UNANSWERED = "The bridge did not confirm the command. Check the arm at the cell before trying again; Cobblr never resends it.";
const stops = (c: ArmCommand) => c.operation === "pause" || c.operation === "stop" || c.operation === "power" && c.state === "off";
/** Send one command to an arm and record who sent it, whatever the outcome.
 *  Pause and stop go out at once from any member; everything that makes the
 *  arm do more needs a person at its authorized station. */
export async function sendArmCommand(db: Kysely<DigifabDB>, orgId: string, machineId: string, value: unknown, actor: ArmActor, opts: { run?: { id: string } } = {}): Promise<{ ok: boolean; detail?: string; state: ArmState | null; run_id?: string; unanswered?: boolean }> {
 const input = ArmCommandInput.parse(value), command = input.command;
 const unit = await requireUnit(db, machineId);
 if (!unit.connection_id || !unit.device_id) throw new ArmRefusal("This arm has no controller connection. Run it at its pendant.");
 let permit: ArmPermit | null = null, programId: string | null = null;
 if (command.operation !== "pause" && command.operation !== "stop") {
  if (actor.via !== "station") throw new ArmRefusal("Load, start, resume and power are sent from the arm's authorized station.");
  if (command.operation === "power" ? !actor.admin : !actor.operate) throw new ArmRefusal(command.operation === "power" ? "Switching an arm's power needs an owner or admin." : "Running an arm needs an operator, an owner or an admin.");
  if (command.operation === "start" && !opts.run) throw new ArmRefusal("Start a run at the arm's station: a start needs a person's approval for this program and tooling.");
  permit = await authorizeArm(db, unit.connection_id, unit.device_id, input.station_token);
  if (unit.maintenance === "down-for-repair" && !stops(command)) throw new ArmRefusal("This arm is down for repair. Return it to service first.");
  if (!stops(command)) {
   const own = await db.selectFrom("digifab_arm_ownership").selectAll().where("machine_id", "=", machineId).executeTakeFirst();
   const refused = ownershipRefusal(own ?? null, permit.stationId!, null, new Date());
   if (refused) throw new ArmRefusal(refused);
  }
 }
 if (command.operation === "load" || command.operation === "start") {
  const p = command.program;
  const program = await db.selectFrom("digifab_arm_programs").select(["id", "missing_since"]).where("machine_id", "=", machineId).where("name", "=", p.name).where(eb => p.revision === null ? eb("revision", "is", null) : eb("revision", "=", p.revision)).executeTakeFirst();
  if (!program) throw new ArmRefusal("This program and revision are not recorded for this arm. Read its programs again or add it.");
  if (program.missing_since) throw new ArmRefusal("The controller no longer lists this program revision. Read its programs again.");

  programId = program.id;
 }
 const driver = await armDriver(db, orgId, unit.connection_id);
 let result: ArmCommandResult, unanswered = false;
 const send = async () => { try { return await driver.command(permit, unit.device_id!, command); } catch { unanswered = true; return { ok: false, detail: UNANSWERED }; } };
 if (stops(command)) result = await send();
 else {
  let state: ArmState | null = null;
  try { state = await driver.state(unit.device_id); } catch { state = null; }
  const refusal = armCommandRefusal(command, state) ?? (state?.mode === "local" ? "The pendant has control of the arm." : null);
  result = refusal ? { ok: false, detail: refusal } : await send();
 }
 const { operation, ...params } = command;
 await db.insertInto("digifab_arm_commands").values({ machine_id: machineId, operation, program_id: programId, params: JSON.stringify({ ...params, ...(opts.run ? { run: opts.run.id } : {}) }), user_id: actor.userId, via: actor.via, ok: result.ok, detail: result.detail ?? "" }).execute();
 await platform().activity.log({ orgId, userId: actor.userId, action: "arm_command", ref: machineRef(machineId), diff: { operation, ...params, via: actor.via, ok: result.ok, ...(result.detail ? { detail: result.detail } : {}) } });
 if (opts.run) return { ok: result.ok, detail: result.detail, state: result.state ?? null, run_id: result.run_id ?? result.state?.run_id ?? undefined, unanswered };
 if (!result.ok) throw new ArmRefusal(result.detail || UNANSWERED);
 return { ok: true, detail: result.detail, state: result.state ?? null };
}
