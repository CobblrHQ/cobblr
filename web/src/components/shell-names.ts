// The names the shell gives its own controls. The shell draws them with these
// and the walks look for them by these (e2e/fundamentals-shell-walk.mjs), so a
// rename reaches both at once instead of timing out a nightly walk (#8510).
// Plain constants only: node loads this file straight from the walks.

/** The brand link in both header layouts: named for where it goes (#8287). */
export const BRAND_HOME = "Home";
