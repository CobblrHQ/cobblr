// The core-print driver contract. Intentionally TINY and document-shaped —
// "send these bytes to a queue, get a job back" — NOT digifab's fab MachineDriver
// (no file→slice→placement). A future `core-devices` substrate would host both
// shapes side by side; for now each is small enough to stand alone.

export interface PrintDoc {
  bytes: Uint8Array;
  filename: string;
  /** MIME type — application/pdf, image/png, application/octet-stream (raw/ZPL), … */
  contentType: string;
}

export interface PrintJobResult {
  /** Manager-assigned job id (string for portability). */
  jobId: string;
  /** Coarse state the manager reported at submit time. */
  state: "pending" | "processing" | "completed" | "stopped" | "unknown";
}

/** Settings a Bluetooth thermal printer needs. Stored as DATA on the printer row
 *  so the browser reads them at print time — nothing model-specific is compiled
 *  into the front end, and supporting a new printer stays a profile entry. */
export interface BluetoothPrinterSettings {
  /** Profile id from @cobblr/thermal-print KNOWN_PROFILES, when recognised. */
  profileId?: string;
  /** Command family the printer speaks. LABEL printers are commonly TSPL and are
   *  SILENT to ESC/POS, so this is not cosmetic. */
  protocol: "tspl" | "phomemo";
  /** Dots per line for the loaded media (320 = 40mm roll @203dpi). */
  widthDots: number;
  /** GATT write characteristic, when pinned. Otherwise discovered + ranked. */
  writeCharUuid?: string;
  /** TSPL geometry. Wrong values drift the image ~1mm/label off the edge. */
  labelHeightMm?: number;
  gapMm?: number;
  /** 0 and 1 differ by 180°; which is upright is per-model. */
  direction?: 0 | 1;
  /** Calibrated dead zone at the top of the label, in dots. */
  topMarginDots?: number;
  density?: number;
  speed?: number;
}

export interface PrinterConfig {
  /** Print-manager base URL (CUPS IPP host, or an edge-bridge URL). Empty for a
   *  browser-Bluetooth printer, which has no network address. */
  baseUrl: string;
  /** Queue / printer name on the manager. */
  queue: string;
  /** Decrypted auth, if the connection stored any. */
  username?: string;
  password?: string;
  apiKey?: string;
  /** Only for driver kind "browser-bluetooth". */
  bluetooth?: BluetoothPrinterSettings;
  /** Edge-bridge routing (shape shared with the browser path — one home for the
   *  settings type). `instance` names the bridge instance; `bridgeName` picks the
   *  tunnel channel; `bridgeUrl` marks a bridge on the user's own machine, which
   *  the BROWSER prints to — this driver layer never fetches it. */
  bridge?: import("@cobblr/platform-contract/edge-bridge-client").BridgePrinterSettings;
}

export interface PrintDriver {
  /** Cheap reachability check. `detail` is an optional human-readable line the
   *  printer reported about ITSELF — a thermal printer's loaded roll and battery,
   *  say. Reachability alone answers "is it plugged in"; the detail answers "is
   *  it ready to print", which is the question someone is actually asking. */
  test(): Promise<{ ok: boolean; error?: string; detail?: string }>;
  /** Submit one document to the queue. */
  print(doc: PrintDoc, opts?: { copies?: number; jobName?: string }): Promise<PrintJobResult>;
}

export type PrintDriverFactory = (cfg: PrinterConfig) => PrintDriver;
