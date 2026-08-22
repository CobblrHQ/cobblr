// Installing the bundle a scan destination needs, and answering the one
// question that follows: which instance to file into.
//
// It is one function because getting it wrong looks like success. Installing a
// bundle reports the target it actually created, and for a bundle that SKINS a
// module's default table (Groceries) that target has no instance at all - while
// the candidate still carries the synthetic token the routing menu needed in
// order to name the bundle. Confirm the candidate verbatim and you ask for an
// instance the install just declined to create.
//
// Three call sites had made that mistake independently (the session header's
// File all, the card's Install & add pill, and the form's Confirm), so a whole
// receipt of groceries failed on every line against a bundle that had installed
// perfectly (2026-08-22). lint:capabilities keeps ScanPage from growing a
// fourth: only this file may reach for materializeQuickstart.

import { api, type BundleInstallSummary } from "../lib/api";

/** Install `bundleId` if there is one, and return the instance to file into.
 *
 *  `candidateInstance` is the fallback, used when there is no bundle to install
 *  or when installing failed - right for a bundle that provides a real
 *  instance, and no worse than not trying for one that does not. */
export async function resolveInstanceForFiling(
  slug: string,
  bundleId: string | null | undefined,
  candidateInstance: string | null | undefined,
  /** Told what the install changed, when it changed anything. A bundle that
   *  skins a module makes nothing appear on screen, so this is the only thing
   *  that answers "did that work?" without going hunting. */
  onInstalled?: (summary: BundleInstallSummary) => void,
): Promise<string | undefined> {
  if (!bundleId) return candidateInstance ?? undefined;
  try {
    const res = await api.materializeQuickstart(slug, bundleId, { item_ids: [] });
    if (res.installed) onInstalled?.(res.installed);
    return res.instance ?? undefined;
  } catch {
    // The confirm that follows fails and is counted. A toast here would say the
    // same thing a second time.
    console.error(`[scan] could not install ${bundleId} before filing`);
    return candidateInstance ?? undefined;
  }
}
