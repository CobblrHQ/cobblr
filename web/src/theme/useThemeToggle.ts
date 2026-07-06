// The quick theme toggle used by the header/account menu and ⌘K, plus a gentle
// one-off nudge to promote a device-local flip to the account default.
//
// The bare `toggle()` (ThemeContext) only ever touches the DEVICE tier — a fast
// "flip this screen." That's deliberate: an impulse shouldn't rewrite a synced,
// account-wide preference. The cost is discoverability — a single-device user who
// only ever taps the toggle never sets an account default, so a brand-new device
// starts from "match device" instead of what they picked. This wrapper closes
// that gap without giving up the safety: when a flip LOCKS this device to a value
// that diverges from the account default, and the user hasn't made a real
// account-level choice yet, offer to also use it on every device. Once they've
// set an explicit default (accepting this counts), the nudge goes quiet for good;
// short of that it shows at most a few times per browser and can be silenced on
// sight. See ThemeContext for the two-tier model.

import { useCallback } from "react";
import { useToast } from "@cobblr/platform-web";
import { useTheme } from "./ThemeContext";

const NUDGE_KEY = "cobblr.theme.promoteNudge"; // per-device: shown-count, or "off"
const MAX_SHOWS = 3;

function nudgeState(): "off" | number {
  if (typeof window === "undefined") return "off";
  const raw = localStorage.getItem(NUDGE_KEY);
  if (raw === "off") return "off";
  return raw ? parseInt(raw, 10) || 0 : 0;
}
function writeNudge(v: string) {
  try {
    localStorage.setItem(NUDGE_KEY, v);
  } catch {
    /* private mode — best effort */
  }
}

/** Quick theme toggle for the icon buttons; also fires the promote-to-account
 *  nudge when appropriate. Drop-in for `useTheme().toggle`. */
export function useThemeToggle(): () => void {
  const { toggle, accountPref, setAccountPref, setDeviceOverride } = useTheme();
  const toast = useToast();

  return useCallback(() => {
    const { locked, value } = toggle();
    // Nothing to promote unless this flip actually diverged from the account
    // default (locked). And once the user HAS an explicit account default, they
    // already made the global call — don't nag.
    if (!locked || accountPref !== null) return;

    const state = nudgeState();
    if (state === "off" || state >= MAX_SHOWS) return;
    writeNudge(String(state + 1));

    toast.action(`You're in ${value} mode on this device.`, {
      actionLabel: "Use on all devices",
      duration: 10000, // let it fade = "not now"; the buttons are the real choices
      onAction: () => {
        setAccountPref(value); // syncs to every device via PATCH /me
        setDeviceOverride(null); // release the local lock so this device follows the default
        writeNudge("off");
      },
      secondaryLabel: "Don't show again",
      onSecondary: () => writeNudge("off"),
    });
  }, [toggle, accountPref, setAccountPref, setDeviceOverride, toast]);
}
