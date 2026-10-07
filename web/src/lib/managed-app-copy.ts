// The signup screen's words for a managed app. Apart from managed-apps.ts
// because it reads the featured bundles (a large table of bundle manifests),
// and managed-apps.ts is read by the app shell on every page (#4945).
import { fillNoun } from "@cobblr/platform-contract/kind-label";
import { FEATURED_BUNDLES } from "./featured-bundles";
import type { ManagedAppMeta } from "./managed-apps";

/** The signup screen's words for an app, with the app bundle's own word for
 *  its things filled in (the default: nobody has chosen yet on this page). */
export function managedAppCopy(meta: ManagedAppMeta): { headline: string; blurb: string } {
  const bundle = FEATURED_BUNDLES.find((b) => b.manifest.id === meta.bundleId);
  const noun = bundle?.manifest.provides_instances?.find((i) => i.noun)?.noun;
  const word = noun ? { singular: noun.singular, plural: noun.plural } : null;
  return {
    headline: word ? fillNoun(meta.headline, word) : meta.headline,
    blurb: word ? fillNoun(meta.blurb, word) : meta.blurb,
  };
}
