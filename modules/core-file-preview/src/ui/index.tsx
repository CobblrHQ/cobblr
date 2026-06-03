// Registers file-preview renderers into platform-web's FilePreview
// registry. Two tiers, and the split is deliberate:
//
//  • UNIVERSAL (svg, …) — any workspace attaches these → registered on
//    import (the host side-effect-imports this module).
//  • FABRICATION (stl, gcode, …) — model + job files only makers/machine
//    users care about. This module stays DOMAIN-AGNOSTIC: it does NOT know
//    `machines`/`digifab` exist. It just exposes register/unregister; the
//    HOST decides when to turn them on (see web FilePreviewGate), the same
//    way the nav gates the scan affordance on core-scan being enabled.
//    That keeps three.js (~690KB, lazy) out of non-fabrication workspaces
//    entirely, and respects module isolation — only the host (like a
//    bundle) is allowed to wire two modules together.
//
// Every renderer is a LAZY loader, so its libs download only when a file
// of that type is actually previewed.

import { registerFilePreviewRenderer, unregisterFilePreviewRenderer } from "@cobblr/platform-web";

// Universal — on for everyone.
registerFilePreviewRenderer(["svg"], () => import("./renderers/SvgRenderer"));

// Fabrication formats — turned on by the host when a fabrication domain is
// enabled. The module names the FORMATS, never the domains.
const FAB_EXTS = ["stl", "gcode", "gco", "g", "nc", "dxf", "3mf", "step", "stp", "iges", "igs"];
export function registerFabricationRenderers(): void {
  registerFilePreviewRenderer(["stl"], () => import("./renderers/StlRenderer"));
  registerFilePreviewRenderer(["gcode", "gco", "g", "nc"], () => import("./renderers/GcodeRenderer"));
  registerFilePreviewRenderer(["dxf"], () => import("./renderers/DxfRenderer"));
  registerFilePreviewRenderer(["3mf"], () => import("./renderers/ThreeMfRenderer"));
  // STEP + IGES share the occt (OpenCASCADE WASM) renderer.
  registerFilePreviewRenderer(["step", "stp", "iges", "igs"], () => import("./renderers/OcctRenderer"));
}
export function unregisterFabricationRenderers(): void {
  unregisterFilePreviewRenderer(FAB_EXTS);
}

// A truthy marker the host can reference so a `sideEffects:false` bundler
// can't tree-shake the universal registration above.
export const filePreviewReady = true;
