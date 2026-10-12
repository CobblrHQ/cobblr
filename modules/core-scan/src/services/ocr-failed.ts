// The OCR engine failed while reading: it crashed, timed out or exited with an
// error. Never "nothing printed here" (#5921): a run killed under load and
// taken as an empty page left a form's misread words to name the vehicle.
// What reads a document turns this into a failure that says so, and a person
// reads the page again; nothing is filed from a read the engine did not finish.
export class OcrFailed extends Error {
  readonly code = "reader_failed" as const;
  constructor(cause: unknown) {
    super(`The OCR engine did not finish: ${(cause as Error)?.message ?? String(cause)}`.slice(0, 300));
    this.name = "OcrFailed";
  }
}

export function isOcrFailed(err: unknown): err is OcrFailed {
  return err instanceof OcrFailed || (err as { code?: unknown } | null)?.code === "reader_failed";
}
