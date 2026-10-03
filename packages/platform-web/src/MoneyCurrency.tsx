import { createContext, useContext, type ReactNode } from "react";
import { CURRENCIES, DEFAULT_CURRENCY, setDisplayCurrency } from "@cobblr/platform-contract/money";
const CurrencyContext = createContext(DEFAULT_CURRENCY);
export function MoneyCurrencyProvider({ currency, children }: { currency: string; children: ReactNode }) {
  setDisplayCurrency(currency);
  return <CurrencyContext.Provider value={currency}>{children}</CurrencyContext.Provider>;
}
export function useMoneyCurrency(): string { return useContext(CurrencyContext); }
export function CurrencyPicker({ value, onChange, label = "Currency", disabled = false }: { value: string; onChange: (currency: string) => void; label?: string; disabled?: boolean }) {
  return <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} className="input min-w-0 max-w-full w-24 shrink-0">
    {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
  </select>;
}
