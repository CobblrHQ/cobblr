export function instrumentReadingText(value: number, unit: string): string {
 if (!Number.isFinite(value) || !["V", "A", "ohm", "Hz", "s", "F", "W", "C"].includes(unit)) throw new Error("The instrument reading has no verified value or unit.");
 return [String(value), unit].join(" ");
}
