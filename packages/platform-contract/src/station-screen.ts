// A Station: a tablet or counter screen that a barcode scanner drives (#4640).
//
// Each station has an address in its workspace (`/station/<workspace>/pantry`),
// and opening that address on a tablet is the whole setup: the tablet shows a
// short code, an owner or admin approves it from their own screen, and the
// tablet holds a token that reaches only that station. One copy of the
// address grammar, the code alphabet and the settings for the api, the
// core-scan module and the web, so none of them can disagree.

/** A station address: lowercase words and dashes, as typed into a URL. */
export const STATION_ADDRESS_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** The address the plain `/station/<workspace>` opens. */
export const DEFAULT_STATION_ADDRESS = "station";

/** The words other station screens already use under `/station`, which a
 *  scanner station's address can never be. */
export const RESERVED_STATION_ADDRESSES = new Set(["floor", "printer", "machine"]);

export function isStationAddress(v: unknown): v is string {
  return typeof v === "string" && STATION_ADDRESS_RE.test(v) && !RESERVED_STATION_ADDRESSES.has(v);
}

/** "pantry-shelf" reads as "Pantry shelf". */
export function stationLabelOf(address: string): string {
  const words = address.replace(/-+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "Station";
}

/** What the activity log and the token list call a station's device. */
export function stationDeviceName(label: string): string {
  const l = label.trim() || "Scan";
  return /\bstation$/i.test(l) ? l : `${l} station`;
}

// ── The approval code ──────────────────────────────────────────────────────
// Six characters from an alphabet without the look-alikes (0/O, 1/I/L), read
// off the tablet and typed on a phone: 31^6 is about 8.9e8 against a code that
// lives fifteen minutes behind a per-IP limit and is only worth anything to a
// signed-in owner or admin of the workspace it names.
export const STATION_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const STATION_CODE_LENGTH = 6;
export const STATION_REQUEST_TTL_MS = 15 * 60_000;

/** What a person typed, as the code it means (case, spaces and dashes
 *  ignored), or null when it cannot be one. */
export function normalizeStationCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const c = raw.toUpperCase().replace(/[\s-]+/g, "");
  if (c.length !== STATION_CODE_LENGTH) return null;
  for (const ch of c) if (!STATION_CODE_ALPHABET.includes(ch)) return null;
  return c;
}

/** The token scope a station's device carries: it reaches that station's own
 *  routes and the scan intake, nothing else (api/src/auth/scopes.ts). */
export function stationScope(address: string): string {
  return `station:${address}`;
}

export function stationAddressOfScope(scope: string): string | null {
  const m = /^station:(.+)$/.exec(scope);
  return m && isStationAddress(m[1]) ? m[1]! : null;
}

/** A phone that claimed a station's kitchen QR (#5353): it reaches that
 *  station's lookup and the few presses the owner chose, nothing else. */
export function stationQrScope(address: string): string {
  return `station-qr:${address}`;
}

export function stationQrAddressOfScope(scope: string): string | null {
  const m = /^station-qr:(.+)$/.exec(scope);
  return m && isStationAddress(m[1]) ? m[1]! : null;
}

/** What a kitchen QR's token is called, in Devices and in history lines. */
export function stationQrName(label: string): string {
  return `${stationDeviceName(label)} QR`;
}

/** What a phone holding the kitchen QR may do at this station: "use one"
 *  when the owner allowed it, and the actions the owner ticked, and only
 *  those that the station itself offers. */
export function stationQrMay(settings: Pick<StationSettings, "qr_use_one" | "qr_actions">, press: { op?: string; action_id?: string }): boolean {
  if (press.op !== undefined) return press.op === "use" && settings.qr_use_one;
  if (press.action_id !== undefined) return settings.qr_actions.includes(press.action_id);
  return false;
}

// ── Settings ───────────────────────────────────────────────────────────────

/** What a scan of something you already have does. `ask` shows the record's
 *  buttons; the others apply at once and show "Added 1 · Undo". */
export const STATION_ACTIONS = ["ask", "add-one", "use-one"] as const;
export type StationAction = (typeof STATION_ACTIONS)[number];

export interface StationSettings {
  /** The default for a known thing (the issue's "Default action"). */
  action: StationAction;
  /** Every scan of a repeat counts in One-tap; otherwise a second scan of the
   *  same code within REPEAT_WINDOW_MS counts once. */
  count_repeats: boolean;
  /** The collections this station reaches, as entity kinds (`groceries:item`).
   *  Empty: every collection a scan can land in. */
  collections: string[];
  /** Where a new thing is headed: a collection kind and a place. */
  new_kind: string | null;
  new_location_id: string | null;
  /** Back to "Ready to scan" after this many seconds with no touch. */
  reset_seconds: number;
  /** A tone and a flash on success or failure, for a counter nobody looks at. */
  sound: boolean;
  flash: boolean;
  /** Light, dark, or follow the device. */
  theme: "system" | "light" | "dark";
  /** Larger type for reading across a room. */
  large_text: boolean;
  /** A camera on the screen itself, for a tablet with no scanner (#5353): the
   *  front one (a wall tablet you hold a jar up to), the back one, or ask the
   *  device once. Off by default: a station with a scanner keeps its screen. */
  camera: StationCamera;
  /** A dashboard this station is opened from (Home Assistant), and what the
   *  button back to it says. Null: no button. */
  back_url: string | null;
  back_label: string;
  /** What a phone holding this station's kitchen QR may press (#5353): "used
   *  one", and the station's own actions by id. The QR itself is turned on
   *  and printed from the settings; nothing here works without it. */
  qr_use_one: boolean;
  qr_actions: string[];
}

export const STATION_CAMERAS = ["off", "front", "rear", "ask"] as const;
export type StationCamera = (typeof STATION_CAMERAS)[number];
/** A device's own pick of lens, which outranks the station's. */
export type StationLens = "front" | "rear";

/** The lens a station's camera opens: the device's own pick (its flip
 *  button, or its answer to "ask"), else the station's setting. Null when
 *  the station has no camera, "ask" when nothing has been picked yet. */
export function stationLens(camera: StationCamera, devicePick: StationLens | null): StationLens | "ask" | null {
  if (camera === "off") return null;
  if (devicePick) return devicePick;
  return camera === "ask" ? "ask" : camera;
}

/** A back address the button may open: http or https, nothing else. */
export function stationBackUrl(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim() || v.length > 500) return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export const DEFAULT_STATION_SETTINGS: StationSettings = {
  action: "ask",
  count_repeats: false,
  collections: [],
  new_kind: null,
  new_location_id: null,
  reset_seconds: 8,
  sound: true,
  flash: true,
  theme: "system",
  large_text: false,
  camera: "off",
  back_url: null,
  back_label: "Home Assistant",
  qr_use_one: true,
  qr_actions: [],
};

/** The stock move a One-tap station makes on every scan of a known thing,
 *  or null for a station that asks. */
export function oneTapOp(action: StationAction): "add" | "use" | null {
  return action === "add-one" ? "add" : action === "use-one" ? "use" : null;
}

export const REPEAT_WINDOW_MS = 2_000;
export const ONE_TAP_UNDO_MS = 5_000;

/** A stored settings blob, read back as settings: anything missing or wrong
 *  takes the default, so a station saved before a setting existed still opens. */
export function stationSettingsOf(raw: unknown): StationSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_STATION_SETTINGS;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const secs = Number(r.reset_seconds);
  return {
    action: (STATION_ACTIONS as readonly string[]).includes(r.action as string) ? (r.action as StationAction) : d.action,
    count_repeats: typeof r.count_repeats === "boolean" ? r.count_repeats : d.count_repeats,
    collections: Array.isArray(r.collections) ? r.collections.filter((k): k is string => typeof k === "string" && !!k.trim()).slice(0, 50) : d.collections,
    new_kind: str(r.new_kind),
    new_location_id: str(r.new_location_id),
    reset_seconds: Number.isFinite(secs) && secs >= 3 && secs <= 600 ? Math.round(secs) : d.reset_seconds,
    sound: typeof r.sound === "boolean" ? r.sound : d.sound,
    flash: typeof r.flash === "boolean" ? r.flash : d.flash,
    theme: r.theme === "light" || r.theme === "dark" || r.theme === "system" ? r.theme : d.theme,
    large_text: typeof r.large_text === "boolean" ? r.large_text : d.large_text,
    camera: (STATION_CAMERAS as readonly string[]).includes(r.camera as string) ? (r.camera as StationCamera) : d.camera,
    back_url: stationBackUrl(r.back_url),
    back_label: str(r.back_label)?.slice(0, 40) ?? d.back_label,
    qr_use_one: typeof r.qr_use_one === "boolean" ? r.qr_use_one : d.qr_use_one,
    qr_actions: Array.isArray(r.qr_actions) ? r.qr_actions.filter((a): a is string => typeof a === "string" && /^[a-z0-9-]+:[a-z0-9-]+$/.test(a)).slice(0, 20) : d.qr_actions,
  };
}

/** Whether a record of `kind` is one this station may reach. */
export function stationReaches(settings: Pick<StationSettings, "collections">, kind: string): boolean {
  return settings.collections.length === 0 || settings.collections.includes(kind);
}

// ── What the screen shows for one scan ─────────────────────────────────────

export type StationStockOp = "add" | "use" | "total";

export interface StationRecord {
  kind: string;
  id: string;
  instance: string | null;
  title: string;
  image_path: string | null;
  /** The count, when the kind keeps one; null for a one-off thing. */
  qty: number | null;
  location_id: string | null;
  location_name: string | null;
  detail_url: string | null;
}

export type StationLookup =
  | { found: "record"; record: StationRecord; countable: boolean; matched_by: "label" | "barcode" | "identifier" }
  | { found: "outside"; title: string }
  | { found: "none" };

export interface StationMove {
  request_id: string;
  op: StationStockOp;
  delta: number;
  qty: number | null;
  /** The door's own sentence when it clamped or refused. */
  note: string | null;
}
