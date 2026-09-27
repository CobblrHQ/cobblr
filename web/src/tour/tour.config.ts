// THE guided tour, as one easy-to-edit schema.
//
// Add, remove, reorder, or reword steps by editing the arrays below — nothing
// else needs to change. A `spotlight` step points at a real element by its
// `data-tour="<name>"` attribute; if that element is not on the page (a module
// that is off, a dashboard card that was removed), the step is skipped
// automatically. So the tour always matches the workspace in front of the user.
//
// To add a step: mark an element in the UI with `data-tour="my-thing"`, then add
// `{ kind: "spotlight", target: '[data-tour="my-thing"]', title, body }` here.

import { NAV_LAYOUTS, setNavLayout, type NavLayout } from "../lib/nav-mode";

/** What a step says on a PHONE instead, where the desktop's words do not
 *  apply (a layout to choose, a row of places, ⌘K, a phone to pair). A step
 *  without one reads the same on both. `target` re-points a spotlight at the
 *  phone's own anchor (the menu that holds every place). */
export interface PhoneVariant {
  title?: string;
  body: string;
  target?: string | string[];
}

/** What the engine can see where a step points, for a body that has to say
 *  something different when the shell folded. Read live from the spotlit
 *  element, so it is true at the width the reader has, not the width the
 *  copy was written at (#3256). */
export interface StepContext {
  /** The nav folded rows into "more", so the row does not hold them. */
  folded: boolean;
}

/** A step's words: fixed, or derived from what is on screen. */
export type StepBody = string | ((ctx: StepContext) => string);

export type TourStep =
  | { kind: "chooseLayout"; title: string; body: string; phone: PhoneVariant }
  // The welcome a phone gets: the greeting, the theme toggle and the way in,
  // with no layout to choose. Made by tourStepsFor from chooseLayout's phone
  // variant; never written into the tour by hand.
  | { kind: "welcome"; title: string; body: string }
  // `target` is a CSS selector, or an ORDERED list of them: the tour uses the
  // first one that is on screen (prefer anchor A, fall back to anchor B). A step
  // whose target(s) are all absent is skipped.
  | { kind: "spotlight"; target: string | string[]; title: string; body: StepBody; phone?: PhoneVariant }
  // Put Cobblr on the home screen. A phone's step only: a desktop never sees
  // it, and neither does an app already running from the home screen or a
  // person who said not now. Its words depend on the browser (install-app.ts),
  // so the step carries only its title.
  | { kind: "installApp"; title: string }
  | { kind: "done"; title: string; body: string; phone?: PhoneVariant };

export const DASHBOARD_TOUR: TourStep[] = [
  {
    kind: "chooseLayout",
    title: "Welcome to Cobblr",
    body: "First, how do you want to get around? Try each; you can change it any time under Your account, Appearance.",
    // A phone has one way around and is not asked to choose one (#3231): its
    // welcome says where things are and offers the look.
    phone: {
      body: "This is your workspace. On a phone the menu at the top right holds every place, and the camera beside it captures anything with a barcode or a label. Have a quick look around, or skip straight in.",
    },
  },
  {
    kind: "spotlight",
    target: '[data-tour="workspace"]',
    title: "Your workspaces",
    body: "All your workspaces live here. Each one is a separate space with its own data. Add another or switch between them any time.",
  },
  {
    kind: "spotlight",
    target: '[data-tour="nav"]',
    title: "Your places",
    // The row folds what does not fit into "more" (ModuleNav), and at a
    // tablet's width that is everything but Home, so the fixed sentence named
    // two rows the reader could not see (#3256). It now says where they went.
    body: (ctx) =>
      ctx.folded
        ? "Home is where you start. The rest of your places are behind more, at the end of this row: Locations, where things live, the Scan Inbox, what your camera captured, and a row for each collection you set up."
        : "Home is where you start. Locations is where things live, and the Scan Inbox is what your camera captured. Everything else in this row is a collection you set up.",
    phone: {
      target: '[data-tour="menu"]',
      body: "Every place is behind this menu: Home is where you start, Locations is where things live, the Scan Inbox is what your camera captured, and each collection you set up gets a row. Your account and settings are at its foot.",
    },
  },
  {
    kind: "spotlight",
    target: '[data-tour="do-box"]',
    title: "Start here",
    body: "Type what you've got and Cobblr finds or builds the right home for it - the fastest way to fill a new workspace. Or scan it. A few ready-made setups sit under the box; everything else is behind More ways to start. Press ⌘K any time to jump anywhere.",
    phone: {
      body: "Type what you've got and Cobblr finds or builds the right home for it - the fastest way to fill a new workspace. Or scan it. A few ready-made setups sit under the box; everything else is behind More ways to start.",
    },
  },
  {
    kind: "spotlight",
    target: '[data-tour="more-ways"]',
    title: "Browse everything",
    body: "Every way to start, in one place: ready-made bundles with the fields already shaped, full setups that wire several modules together, or a blank module you shape yourself.",
  },
  {
    kind: "spotlight",
    // Prefer the capture card's scan button (new-user flow); fall back to the
    // always-present header camera if that card isn't shown.
    target: ['[data-tour="capture-scan"]', 'a[href$="/scan/camera"]'],
    title: "Scan to capture",
    body: "Rather not type it? Scan a barcode or label with your phone and it files itself. No camera on this computer? Pair your phone in a tap and scan with that. Not now? Try a sample scan and watch one land.",
    phone: {
      body: "Rather not type it? Point the camera at a barcode or a label and it files itself. Not now? Try a sample scan and watch one land.",
    },
  },
  {
    kind: "spotlight",
    target: '[data-tour="account"]',
    title: "Your account",
    body: "Your account, feedback, and settings live here, and you can replay this tour whenever you like.",
  },
  {
    kind: "installApp",
    title: "Put Cobblr on your home screen",
  },
  {
    kind: "done",
    title: "You are all set",
    body: "That is the tour. Replay it any time from the account menu, and switch layout whenever you like.",
    phone: {
      body: "That is the tour. Replay it any time from Your account, in the menu.",
    },
  },
];

/** Below this width the shell is the phone menu and no desktop layout applies. */
export const PHONE_MAX_WIDTH = 768;

/** The steps a tour on this width can ask. A phone is never asked which
 *  desktop layout it wants: the three answers mean nothing to the phone in
 *  hand, and it was the first thing a visitor signing up on one met (#3231).
 *  Instead its welcome says where things are, and every step that talked to a
 *  desktop (a row of places, ⌘K, a phone to pair) says the phone's version,
 *  pointing at the phone's own anchors. A desktop reads the steps as written. */
export function tourStepsFor(steps: TourStep[], viewportWidth: number): TourStep[] {
  if (viewportWidth >= PHONE_MAX_WIDTH) return steps.filter((s) => s.kind !== "installApp");
  return steps.map((s): TourStep => {
    if (s.kind === "chooseLayout") return { kind: "welcome", title: s.phone.title ?? s.title, body: s.phone.body };
    if (s.kind === "welcome" || s.kind === "installApp" || !s.phone) return s;
    if (s.kind === "spotlight") return { ...s, target: s.phone.target ?? s.target, title: s.phone.title ?? s.title, body: s.phone.body };
    return { ...s, title: s.phone.title ?? s.title, body: s.phone.body };
  });
}

// The layouts the welcome step offers: all three, with the names, blurbs and
// pictures Appearance uses (NAV_LAYOUTS), so the tour and the settings page
// describe one model and a person already on the middle one is shown as
// selected rather than as neither. The tour used to offer the two ends only.
// `apply` reskins the whole app live through the same synced layout setter
// Appearance uses: one write, not two.
export interface LayoutOption {
  id: NavLayout;
  label: string;
  desc: string;
  apply: () => void;
}

export const LAYOUT_OPTIONS: LayoutOption[] = NAV_LAYOUTS.map((l) => ({
  id: l.value,
  label: l.label,
  desc: l.desc,
  apply: () => setNavLayout(l.value),
}));
