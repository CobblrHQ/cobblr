export type PrinterKind = "klipper-moonraker" | "octoprint" | "prusalink" | "duet-rrf";
export interface PrinterFirmware {
  type: PrinterKind;
  detail: string;
  name?: string;
  model?: string;
  serial?: string;
}
export const DETECT_PROBES = [
  { path: "/server/info", tag: "moonraker-server" },
  { path: "/printer/info", tag: "moonraker" },
  { path: "/api/version", tag: "version" },
  { path: "/rr_model", tag: "duet-model" },
  { path: "/machine/status", tag: "duet" },
] as const;
type ProbeTag = typeof DETECT_PROBES[number]["tag"];
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() && !/[\x00-\x1f]/.test(value) ? value.trim().slice(0, 120) : undefined;
export function classifyFirmware(tag: ProbeTag, json: unknown): PrinterFirmware | null {
  const body = object(json);
  if (!body) return null;
  const result = object(body.result);
  if (tag === "moonraker-server" || tag === "moonraker") {
    if (!result || (tag === "moonraker-server" && typeof result.moonraker_version !== "string") || (tag === "moonraker" && typeof result.state !== "string")) return null;
    return { type: "klipper-moonraker", detail: "Moonraker responded", name: text(result.hostname) };
  }
  if (tag === "version") {
    const brand = [body.text, body.server, body.name].filter(v => typeof v === "string").join(" ").toLowerCase();
    const printer = object(body.printer);
    if (brand.includes("prusa")) return { type: "prusalink", detail: "/api/version reports PrusaLink", name: text(body.hostname), model: text(printer?.model), serial: text(printer?.serial) };
    if (brand.includes("octoprint") || (typeof body.api === "string" && typeof body.server === "string")) return { type: "octoprint", detail: "/api/version reports OctoPrint", name: text(body.hostname) };
    return null;
  }
  const model = tag === "duet-model" ? result : body;
  if (!model) return null;
  const board = Array.isArray(model.boards) ? object(model.boards[0]) : null;
  const state = object(model.state);
  if (!(typeof state?.status === "string" || (typeof board?.firmwareName === "string" && /reprapfirmware/i.test(board.firmwareName)))) return null;
  return { type: "duet-rrf", detail: "Duet object model responded", name: text(object(model.network)?.name), model: text(board?.name), serial: text(board?.uniqueId) };
}
export type FirmwareProbe = (url: string) => Promise<unknown | undefined>;
export async function detectPrinterFirmware(base: string, probe: FirmwareProbe, only?: PrinterKind): Promise<PrinterFirmware | null> {
  for (const { path, tag } of DETECT_PROBES) {
    if (only === "klipper-moonraker" && !tag.startsWith("moonraker")) continue;
    if ((only === "octoprint" || only === "prusalink") && tag !== "version") continue;
    if (only === "duet-rrf" && !tag.startsWith("duet")) continue;
    const json = await probe(`${base.replace(/\/+$/, "")}${path}`);
    const hit = classifyFirmware(tag, json);
    if (hit) return hit;
  }
  return null;
}

/** A G-code controller's web API (FluidNC, grblHAL, GRBL on an ESP3D board): its version, then its settings. */
export const CONTROLLER_PROBES = { version: "/command?commandText=%24I", settings: "/command?commandText=%24%24" } as const;
export type ControllerKind = "fluidnc-laser" | "grblhal-laser" | "grbl-laser" | "fluidnc";
const FAMILY = { fluidnc: "FluidNC", grblhal: "grblHAL", grbl: "GRBL" } as const;

/** Pure: a controller's `$I` reply, and its `$$` settings when it gave them. In laser mode (`$32=1`) it is
 *  its family's laser driver; FluidNC out of laser mode is the plain FluidNC driver; GRBL and grblHAL out of
 *  laser mode are CNCs, which connect through the bridge, so null. */
export function classifyController(version: string, settings: string | null): { type: ControllerKind; detail: string } | null {
  if (!/\[VER:/.test(version)) return null;
  const family = /fluidnc/i.test(version) ? "fluidnc" : /grblhal/i.test(version) ? "grblhal" : "grbl";
  if (settings && /^\$32=1\s*$/m.test(settings)) return { type: `${family}-laser`, detail: `${FAMILY[family]} controller in laser mode answered` };
  return family === "fluidnc" ? { type: "fluidnc", detail: "a FluidNC controller answered (not in laser mode)" } : null;
}

/** A plain-text probe: the reply's text, or undefined when nothing answered 200. */
export type TextProbe = (url: string) => Promise<string | undefined>;
/** What G-code controller answers at an address, asking its version and then its settings; null when none. */
export async function detectControllerFirmware(base: string, probe: TextProbe): Promise<{ type: ControllerKind; detail: string } | null> {
  const root = base.replace(/\/+$/, "");
  const version = await probe(`${root}${CONTROLLER_PROBES.version}`);
  if (!version || !/\[VER:/.test(version)) return null;
  return classifyController(version, (await probe(`${root}${CONTROLLER_PROBES.settings}`)) ?? null);
}

