// Post-install "where to start" cards, persisted per-workspace in localStorage
// so they survive navigation (the author: "once I navigated away I could never find it
// again"). Written on a successful bundle install; the dashboard renders one
// card per entry with the bundle's next-steps, dismissible once you're oriented.
//
// Stored per workspace slug. Capped + de-duped by externalId (re-installing or
// updating a bundle refreshes its card to the top rather than stacking).

import { useSyncExternalStore } from "react";
import type { BundleNextStep } from "./featured-bundles";

export interface SetupCard {
  externalId: string;
  name: string;
  glyph: string;
  nextSteps: BundleNextStep[];
  /** epoch ms; for ordering newest-first. */
  installedAt: number;
}

const MAX = 6;
const key = (slug: string) => `cobblr.setup.${slug}`;
const EVENT = "cobblr:setup-cards";

export function getSetupCards(slug: string): SetupCard[] {
  try {
    const raw = localStorage.getItem(key(slug));
    const list = raw ? (JSON.parse(raw) as SetupCard[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function recordSetup(slug: string, card: Omit<SetupCard, "installedAt">): void {
  try {
    const list = getSetupCards(slug).filter((c) => c.externalId !== card.externalId);
    list.unshift({ ...card, installedAt: Date.now() });
    localStorage.setItem(key(slug), JSON.stringify(list.slice(0, MAX)));
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* localStorage unavailable — the card is a convenience, not load-bearing. */
  }
}

export function dismissSetup(slug: string, externalId: string): void {
  try {
    const list = getSetupCards(slug).filter((c) => c.externalId !== externalId);
    localStorage.setItem(key(slug), JSON.stringify(list));
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* ignore */
  }
}

/** Reactive read of the workspace's setup cards (re-renders on record/dismiss
 *  in this or another tab). */
export function useSetupCards(slug: string): SetupCard[] {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener(EVENT, onChange);
      window.addEventListener("storage", onChange);
      return () => {
        window.removeEventListener(EVENT, onChange);
        window.removeEventListener("storage", onChange);
      };
    },
    () => localStorage.getItem(key(slug)) ?? "",
  ) === ""
    ? []
    : getSetupCards(slug);
}
