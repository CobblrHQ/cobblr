// The one precedence rule for light or dark: this device's lock, else the
// account's default, else the device's OS. ThemeContext resolves with it once
// React is up, and web/public/prepaint.js applies the same rule before the
// first paint (a plain script cannot import this file, so
// a-dark-mode-user-never-sees-a-light-page-first.test.ts runs prepaint.js
// against every combination and holds the two to one answer).
export type Theme = "light" | "dark";
/** Account pref: null = "match device" (follow this device's OS). */
export type ThemePref = Theme | null;
/** Device override: a hard "light"/"dark" lock, "os" = follow THIS device's OS
 *  (independent of the account default), or null = no override (use account). */
export type DeviceOverride = Theme | "os" | null;

export function resolveTheme(deviceOverride: DeviceOverride, accountPref: ThemePref, os: Theme): Theme {
  if (deviceOverride === "light" || deviceOverride === "dark") return deviceOverride;
  if (deviceOverride === "os") return os;
  return accountPref ?? os;
}
