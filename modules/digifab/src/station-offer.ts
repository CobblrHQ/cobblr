import type { MachineDriver, RemoteDevice } from "./drivers/types.js";

// A print, resin or large-format station is the screen of a print process the
// driver runs. A device that only calls itself a printer has none, so the fleet
// never offers its station: the test printers did, and the card opened a page
// that said "no station screen yet" while a print waited for its verdict (#8645).
const PROCESS_KIND = { fdm: "print", resin: "resin", "large-format": "large-format" } as const;
type ProcessKind = (typeof PROCESS_KIND)[keyof typeof PROCESS_KIND];
const PROCESS_KINDS: ReadonlySet<string> = new Set(Object.values(PROCESS_KIND));

export function printProcessKind(driver: Pick<MachineDriver, "printProcess"> | null | undefined): ProcessKind | null {
  return driver?.printProcess ? PROCESS_KIND[driver.printProcess] : null;
}

export function offeredStationKind(kind: RemoteDevice["station_kind"], driver: Pick<MachineDriver, "printProcess"> | null | undefined): RemoteDevice["station_kind"] {
  return kind && PROCESS_KINDS.has(kind) && printProcessKind(driver) !== kind ? undefined : kind;
}
