export type StationMode = "navigate" | "print" | "file";
export interface StationRef { kind: string; id: string; name: string; path?: string }
export interface StationPlacement {
  container: StationRef | null;
  slot?: string | null;
  position?: { x_mm: number; y_mm: number } | null;
}
export interface StationResult {
  driven: boolean;
  kind: "qr" | "barcode" | "station";
  action?: "navigate" | "print" | "file" | "container" | "open" | "mode" | "undo" | "end" | "refused";
  feedback?: "filed" | "container" | "opened" | "undone" | "ok" | "refused";
  message?: string;
  session_id?: string;
  item_id?: string;
  path?: string;
  queued?: boolean;
}
export interface StationAction {
  code: string;
  result?: StationResult;
  id: string;
  request_id: string;
  at: string;
  type: "file" | "inbox" | "container" | "open" | "mode" | "print" | "navigate" | "refused" | "tag";
  status: "pending" | "done" | "undo_pending" | "undone" | "refused";
  thing?: StationRef;
  before?: StationPlacement;
  after?: StationPlacement;
  context_before: StationRef | null;
  context_after: StationRef | null;
  message: string;
  undo_error?: string;
}
export interface StationSession {
  id: string;
  device_id: string;
  device_name: string;
  started_at: string;
  last_at: string;
  ended_at: string | null;
  notified: boolean;
  actions: StationAction[];
}
export interface StationCommand {
  id: string;
  type: "write" | "link";
  target: StationRef;
  url: string;
  expires_at: string;
  status: "waiting" | "done" | "failed" | "cancelled";
  message?: string;
  uid?: string;
}
export interface ScanStation {
  id: string;
  name: string;
  mode: StationMode;
  context: StationRef | null;
  last_thing: StationRef | null;
  session_id: string | null;
  last_at: string | null;
  command: StationCommand | null;
  last_tag: string | null;
}
export const STATION_IDLE_MS = 10 * 60 * 1000;
export const STATION_CONTROL_PREFIX = "cobblr:station:";
export function stationControl(code: string): "file" | "print" | "navigate" | "undo" | "end" | null {
  const name = code.startsWith(STATION_CONTROL_PREFIX) ? code.slice(STATION_CONTROL_PREFIX.length) : "";
  return name === "file" || name === "print" || name === "navigate" || name === "undo" || name === "end" ? name : null;
}
export function nfcUid(code: string): string | null {
  if (!/^nfc:(?:[a-f\d]{2}){4,10}$/i.test(code)) return null;
  return code.slice(4).toUpperCase();
}
export function sameStationRef(a: StationRef | null | undefined, b: StationRef | null | undefined): boolean {
  return a?.kind === b?.kind && a?.id === b?.id;
}

/** What a station does with a scan, in its mode: the one place the station
 *  page reads it, so an Open or Print station never shows File's steps
 *  (#6035). Each says what is NOT done too, since File is the mode that moves
 *  things. Mirrors StationEngine.scan in api/src/platform/scan-station-engine.ts. */
export function stationModeHelp(mode: StationMode): string {
  if (mode === "navigate") return "Each scan opens that record on a screen following this station. With no screen following, it waits in the scan inbox. Nothing is moved.";
  if (mode === "print") return "Each scan queues a label for that record. Nothing is moved.";
  return "Scan a place, then the things that go there. Scan a holder once to put it away. Scan it twice in a row to put things inside it. Scan any place to leave the holder.";
}

/** Whether the mode keeps a place between scans (File does, for ten idle
 *  minutes); the others never read one, so none is shown for them. */
export const stationUsesPlace = (mode: StationMode): boolean => mode === "file";
