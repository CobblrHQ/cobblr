import { fieldCurrency, readMoney } from "@cobblr/platform-contract/money";
import { coerceMetadata } from "@cobblr/platform-contract/entity-metadata";

export function materialMetadata(...layers: Record<string, unknown>[]): Record<string, unknown> {
  return layers.reduce((md, layer) => ({ ...md, ...layer, money_currencies: { ...coerceMetadata(md.money_currencies), ...coerceMetadata(layer.money_currencies) } }), {});
}

export function materialPrice(metadata: Record<string, unknown>, workspaceCurrency: string) {
  return readMoney(metadata.price_per_kg, "amount", fieldCurrency(metadata, "price_per_kg", workspaceCurrency));
}
