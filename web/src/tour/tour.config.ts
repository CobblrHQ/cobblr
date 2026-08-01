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

import { setNavMode, setNavTopBar } from "../lib/nav-mode";

export type TourStep =
  | { kind: "chooseLayout"; title: string; body: string }
  // `target` is a CSS selector, or an ORDERED list of them: the tour uses the
  // first one that is on screen (prefer anchor A, fall back to anchor B). A step
  // whose target(s) are all absent is skipped.
  | { kind: "spotlight"; target: string | string[]; title: string; body: string }
  | { kind: "done"; title: string; body: string };

export const DASHBOARD_TOUR: TourStep[] = [
  {
    kind: "chooseLayout",
    title: "Welcome to Cobblr",
    body: "First, how do you want to get around? Try each; you can change it any time.",
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
    title: "Your modules",
    body: "Everything this workspace does. Dashboard is home; the rest are the areas you turned on.",
  },
  {
    kind: "spotlight",
    target: '[data-tour="do-box"]',
    title: "Start here",
    body: "Type what you've got and Cobblr finds or builds the right home for it - the fastest way to fill a new workspace. Pick a ready-made bundle on the right, or describe what you have and the AI builder compiles a custom setup. Press ⌘K any time to jump anywhere.",
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
    body: "Rather not type it? Scan a barcode or label with your phone and it files itself. No camera on this computer? Pair your phone in a tap and scan with that.",
  },
  {
    kind: "spotlight",
    target: '[data-tour="account"]',
    title: "Your account",
    body: "Profile, feedback, and settings live here, and you can replay this tour whenever you like.",
  },
  {
    kind: "done",
    title: "You are all set",
    body: "That is the tour. Replay it any time from the account menu, and switch layout whenever you like.",
  },
];

// The two navigation layouts the welcome step offers. `apply` reskins the whole
// app live (it flips the same per-device nav prefs the layout toggle uses).
export interface LayoutOption {
  id: "top" | "side";
  label: string;
  desc: string;
  apply: () => void;
}

export const LAYOUT_OPTIONS: LayoutOption[] = [
  {
    id: "top",
    label: "Top bar",
    desc: "Your modules run across the top of the screen. Simple and roomy when you have a handful of them.",
    apply: () => {
      setNavMode("top");
      setNavTopBar(true);
    },
  },
  {
    id: "side",
    label: "Full sidebar",
    desc: "Everything lives in a column down the left, with room to keep growing as you add more modules.",
    apply: () => {
      setNavMode("side");
      setNavTopBar(false);
    },
  },
];
