// @cobblr/thermal-print — home-agnostic Bluetooth thermal-label core.
//
//   protocol · pure ESC/POS raster encoder (Phomemo M-series)
//   tspl     · TSPL command family (label printers; a PM220S is TSPL-only)
//   media    · unified media+label model; projects into raster footprint / TSPL
//   compose  · thermal n-up: blit N label bitmaps onto one media bitmap
//   calibration · printed-ruler self-calibration (no ruler, no printer support)
//   selftest · escalating self-test sequence + pure target bitmaps
//   profiles · known + harvestable printer profiles
//   ble      · Web Bluetooth transport (browser-only)
//
// Import `./protocol`, `./selftest`, `./profiles` in any runtime; `./ble` only in
// a browser (top-level secure context).

export * from "./protocol.js";
export * from "./selftest.js";
export * from "./tspl.js";
export * from "./media.js";
export * from "./compose.js";
export * from "./calibration.js";
export * from "./profiles.js";
export * from "./ble.js";
