import { browserOffline } from "./waiting-writes";
import { productName } from "./product-name";

export const OFFLINE_SENTENCE = "You're offline. This will work again when you're back online.";

export function networkFailureMessage(): string {
  return browserOffline() ? OFFLINE_SENTENCE : `Can't reach ${productName()}. Check your connection and try again.`;
}
