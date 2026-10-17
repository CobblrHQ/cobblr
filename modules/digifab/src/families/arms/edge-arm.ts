// A robot arm on the shop bridge: the arm routes of the edge-adapter contract
// (@cobblr/platform-contract/robot-arm), over the core driver's one generic
// call. Every arm command goes through here, and only commands the contract
// names can: the schema has no motion and no way to clear a stop. Pause and
// stop need no station; the rest need its permit.
import { ArmCommandResultSchema, ArmCommandSchema, ArmInfoSchema, ArmProgramListSchema, ArmStateSchema, type ArmCommand, type ArmCommandResult, type ArmInfo, type ArmProgramList, type ArmState } from "@cobblr/platform-contract/robot-arm";
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
  async command(permit: ArmPermit | null, deviceId: string, command: ArmCommand): Promise<ArmCommandResult> {
    const parsed = ArmCommandSchema.parse(command);
    if (!["pause", "stop"].includes(parsed.operation) && !hasArmPermit(permit, deviceId)) return { ok: false, detail: "Authorize at the arm's station." };
    return ArmCommandResultSchema.parse(await this.driver.familyRequest("POST", this.path(deviceId, "command"), { body: { command: parsed }, timeoutMs: 20_000 }));
  }
}
