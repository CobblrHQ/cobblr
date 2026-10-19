// A robot arm on the shop bridge: the arm routes of the edge-adapter contract
// (@cobblr/platform-contract/robot-arm), over the core driver's one generic
// call. Every arm command goes through here, and only commands the contract
// names can: the schema has no motion and no way to clear a stop. Pause and
// stop need no station; the rest need its permit.
import { z } from "zod";
import { ArmBackupSchema, ArmCommandResultSchema, ArmCommandSchema, ArmEventPageSchema, ArmInfoSchema, ArmProgramListSchema, ArmProgramRefSchema, ArmProgramSourceSchema, ArmRestoreResultSchema, ArmStateSchema, type ArmBackup, type ArmCommand, type ArmCommandResult, type ArmEventPage, type ArmInfo, type ArmProgramList, type ArmProgramSource, type ArmRestoreResult, type ArmState } from "@cobblr/platform-contract/robot-arm";
import type { EdgeAdapterDriver } from "../../drivers/edge-adapter.js";
import { DriverSaid } from "../../job-truth.js";
import { hasArmPermit, type ArmPermit } from "./station.js";

export class EdgeArm {
  constructor(private readonly driver: EdgeAdapterDriver) {}
  private path(deviceId: string, rest: string) { return `/arm/${encodeURIComponent(deviceId)}/${rest}`; }
  async state(deviceId: string): Promise<ArmState> {
    return ArmStateSchema.parse(await this.driver.familyRequest("GET", this.path(deviceId, "state"), { timeoutMs: 8_000 }));
  }
  async info(deviceId: string): Promise<ArmInfo> {
    return ArmInfoSchema.parse(await this.driver.familyRequest("GET", this.path(deviceId, "info")));
  }
  async programs(deviceId: string): Promise<ArmProgramList> {
    try {
      return ArmProgramListSchema.parse(await this.driver.familyRequest("GET", this.path(deviceId, "programs"), { timeoutMs: 30_000 }));
    } catch (e) {
      if (e instanceof DriverSaid && [404, 501].includes(e.status)) return { supported: false, detail: "This bridge cannot list the arm's programs. Type them here instead." };
      throw e;
    }
  }
  /** The events the arm reported after `after` (a seq). A bridge without
   *  events answers none, so nothing is invented. */
  async events(deviceId: string, after: number): Promise<ArmEventPage> {
    try {
      return ArmEventPageSchema.parse(await this.driver.familyRequest("GET", this.path(deviceId, `events/${after}`)));
    } catch (e) {
      if (e instanceof DriverSaid && [404, 501].includes(e.status)) return { events: [], cursor: after };
      throw e;
    }
  }
  /** A bridge that cannot do one of these answers 501: null, said plainly. */
  private async optional<T>(work: () => Promise<T>): Promise<T | null> {
    try { return await work(); }
    catch (e) { if (e instanceof DriverSaid && [404, 501].includes(e.status)) return null; throw e; }
  }
  async source(deviceId: string, name: string): Promise<ArmProgramSource | null> {
    return this.optional(async () => ArmProgramSourceSchema.parse(await this.driver.familyRequest("GET", this.path(deviceId, `programs/${encodeURIComponent(name)}/source`), { timeoutMs: 30_000 })));
  }
  async upload(deviceId: string, source: ArmProgramSource): Promise<{ ok: boolean; detail?: string; program?: { name: string; revision: string | null } } | null> {
    return this.optional(async () => z.object({ ok: z.boolean(), detail: z.string().max(1000).optional(), program: ArmProgramRefSchema.optional() }).parse(await this.driver.familyRequest("POST", this.path(deviceId, "programs"), { body: { source: ArmProgramSourceSchema.parse(source) }, timeoutMs: 60_000 })));
  }
  async backup(deviceId: string): Promise<ArmBackup | null> {
    return this.optional(async () => ArmBackupSchema.parse(await this.driver.familyRequest("GET", this.path(deviceId, "backup"), { timeoutMs: 120_000 })));
  }
  async restore(deviceId: string, programs: ArmProgramSource[]): Promise<ArmRestoreResult | null> {
    return this.optional(async () => ArmRestoreResultSchema.parse(await this.driver.familyRequest("POST", this.path(deviceId, "restore"), { body: { programs }, timeoutMs: 120_000 })));
  }
  async command(permit: ArmPermit | null, deviceId: string, command: ArmCommand): Promise<ArmCommandResult> {
    const parsed = ArmCommandSchema.parse(command);
    if (!["pause", "stop"].includes(parsed.operation) && !hasArmPermit(permit, deviceId)) return { ok: false, detail: "Authorize at the arm's station." };
    return ArmCommandResultSchema.parse(await this.driver.familyRequest("POST", this.path(deviceId, "command"), { body: { command: parsed }, timeoutMs: 20_000 }));
  }
}
