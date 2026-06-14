// maker-scan router. Mounted at /api/v1/orgs/:slug/modules/maker-scan/.
//
// The module ships no HTTP routes of its own — its whole job is the
// import-time side effect below: registering each vendor scan-URL resolver
// into the platform registry at boot, so core-scan's enrichBarcodeItem (which
// calls platform().scan.resolveUrl) can claim a maker's product URL. The
// platform requires every module's api() to resolve a default Router, so we
// export an empty one.
//
// Talks to the kernel only through platform.* — never a cross-module import
// (per the module-isolation rule). The vendor list lives entirely here.

import { Router } from "express";
import { platform } from "@cobblr/platform-contract";
import { polarResolver } from "../vendors/polar.js";

// Register the vendor resolvers at module load (mountModules calls api()
// for every registered module at boot, so this runs once, globally —
// independent of which workspaces have the module enabled).
platform().scan.registerUrlResolver(polarResolver);
// Add the next maker here: platform().scan.registerUrlResolver(<vendor>Resolver);

const router = Router({ mergeParams: true });

export default router;
