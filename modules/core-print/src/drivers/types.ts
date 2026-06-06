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

export interface PrinterConfig {
  /** Print-manager base URL (CUPS IPP host, or an edge-bridge URL). */
  baseUrl: string;
  /** Queue / printer name on the manager. */
  queue: string;
  /** Decrypted auth, if the connection stored any. */
  username?: string;
  password?: string;
  apiKey?: string;
}

export interface PrintDriver {
  /** Cheap reachability check. */
  test(): Promise<{ ok: boolean; error?: string }>;
  /** Submit one document to the queue. */
  print(doc: PrintDoc, opts?: { copies?: number; jobName?: string }): Promise<PrintJobResult>;
}

export type PrintDriverFactory = (cfg: PrinterConfig) => PrintDriver;
