// A cell on the shop bridge: the cell routes of the edge-adapter contract
// (@cobblr/platform-contract/robot-cell), over the core driver's one generic
// call. Cobblr starts, resumes and stops a cell job here and reads what the
// bridge reports; it never sends a step.
import { CellCommandResultSchema, CellCommandSchema, CellEventPageSchema, CellStateSchema, type CellCommand, type CellCommandResult, type CellEventPage, type CellState } from "@cobblr/platform-contract/robot-cell";
import type { EdgeAdapterDriver } from "../../../drivers/edge-adapter.js";
import { DriverSaid } from "../../../job-truth.js";

export class EdgeCell {
  constructor(private readonly driver: EdgeAdapterDriver) {}
  async state(): Promise<CellState> {
    return CellStateSchema.parse(await this.driver.familyRequest("GET", "/cell/state", { timeoutMs: 8_000 }));
  }
  async events(after: number): Promise<CellEventPage> {
    try {
      return CellEventPageSchema.parse(await this.driver.familyRequest("GET", `/cell/events/${after}`));
    } catch (e) {
      if (e instanceof DriverSaid && [404, 501].includes(e.status)) return { events: [], cursor: after };
      throw e;
    }
  }
  async command(command: CellCommand): Promise<CellCommandResult> {
    return CellCommandResultSchema.parse(await this.driver.familyRequest("POST", "/cell/command", { body: { command: CellCommandSchema.parse(command) }, timeoutMs: 20_000 }));
  }
}
