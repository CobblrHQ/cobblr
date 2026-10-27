import { browserOffline } from "./waiting-writes";
import { productName } from "./product-name";

export const OFFLINE_SENTENCE = "You're offline. This will work again when you're back online.";
/** What a form says when what it sent is kept on the device and goes by
 *  itself once the connection returns (#8637). */
export const KEPT_SENTENCE = "You're offline. It's kept on this device and goes by itself when you're back online.";
/** The code a door's error carries when the write it could not send is kept. */
export const KEPT_OFFLINE = "kept_offline";

/** Whether an error says the write was kept offline, to go by itself later:
 *  a form says so and closes, instead of "couldn't" and a second press. */
export function isKeptOffline(err: unknown): boolean {
  return !!err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === KEPT_OFFLINE;
}

export function networkFailureMessage(): string {
  return browserOffline() ? OFFLINE_SENTENCE : `Can't reach ${productName()}. Check your connection and try again.`;
}
