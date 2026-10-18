// The families' manifest pieces, gathered for src/module.ts: the one place the
// manifest names them (docs/modules/digifab-families.md).
import { armsManifest } from "./arms/manifest.js";
import { embroideryManifest } from "./embroidery/manifest.js";
import { kilnsManifest } from "./kilns/manifest.js";
import { productionManifest } from "./production/manifest.js";

const FAMILY_MANIFESTS = [armsManifest, embroideryManifest, kilnsManifest, productionManifest];
export const FAMILY_PARTS = FAMILY_MANIFESTS.map((f) => f.part);
export const FAMILY_ACTIONS = FAMILY_MANIFESTS.flatMap((f) => f.actions);
export const FAMILY_PANELS = FAMILY_MANIFESTS.flatMap((f) => f.panels);
