export interface NfcRecord {
  recordType: string;
  data: DataView;
}

export interface NfcReader {
  write(message: { records: Array<{ recordType: "url"; data: string }> }, options: { signal: AbortSignal }): Promise<void>;
  scan(options: { signal: AbortSignal }): Promise<void>;
  onreading: ((event: { message: { records: NfcRecord[] } }) => void) | null;
  onreadingerror: (() => void) | null;
}

export function isWebNfcAvailable(): boolean {
  return typeof window !== "undefined" && "NDEFReader" in window;
}

export function createNfcReader(): NfcReader {
  const browser = window as unknown as { NDEFReader: new () => NfcReader };
  return new browser.NDEFReader();
}

export function nfcLabelMessage(url: string): { records: Array<{ recordType: "url"; data: string }> } {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("The tag needs a web link.");
  return { records: [{ recordType: "url", data: url }] };
}

export function nfcUrl(records: readonly NfcRecord[]): string | null {
  const record = records.find((r) => r.recordType === "url");
  return record ? new TextDecoder().decode(record.data) : null;
}

export function nfcFailure(error: unknown): string {
  if (error && typeof error === "object" && "name" in error) {
    if (error.name === "NotAllowedError") return "Allow NFC access in Chrome, then try again.";
    if (error.name === "NotSupportedError") return "Turn on NFC on your phone and use a writable NFC tag.";
    if (error.name === "NotReadableError") return "Could not read the tag. Hold it still near your phone and try again.";
  }
  return "Could not use the tag. Check that NFC is on and the tag is writable, then try again.";
}
