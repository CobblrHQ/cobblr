# @cobblr/thermal-print

Home-agnostic core for Bluetooth thermal label printers (first target: Phomemo
M220). Dependency-free; the pure parts have no I/O or DOM reference, so the same
code drives the standalone printer self-test site, in-app label printing later,
and a future edge/Node helper.

Design + where this fits: [`docs/modules/bluetooth-printer-self-test.md`](../../docs/modules/bluetooth-printer-self-test.md).
Ops: [`docs/operations/printer-selftest-runbook.md`](../../docs/operations/printer-selftest-runbook.md).

## Modules

| Import | Runtime | What |
|---|---|---|
| `./protocol` | any | Pure ESC/POS raster encoder |
| `./selftest` | any | Self-test sequence + pure target bitmaps |
| `./profiles` | any | Known + harvestable printer profiles |
| `./ble` | browser only | Web Bluetooth transport |

`import` the barrel (`@cobblr/thermal-print`) in a browser; import the pure
sub-paths directly in Node.

## Protocol

```ts
import { packMonoBitmap, encodePhomemo, chunkForBle, mmToDots } from "@cobblr/thermal-print";

// RGBA (e.g. canvas ImageData.data) → 1bpp MSB-first bitmap
const bmp = packMonoBitmap(imageData.data, width, height, /* threshold */ 128);
// bitmap → Phomemo command stream (GS v 0 framing + speed/density/media header + feed footer)
const bytes = encodePhomemo(bmp, { speed: 3, density: 8, media: "continuous", init: true });
// split for BLE characteristic writes
const chunks = chunkForBle(bytes, 180);

mmToDots(40); // 320  — media width in mm → dots at 203 dpi
```

Framing reverse-engineered by [vivier/phomemo-tools](https://github.com/vivier/phomemo-tools).
The M220 write characteristic is the classic Phomemo `0xff02` (service `0xff00`),
confirmed on real hardware. The `speed`/`density`/`media`/`init` defaults are
provisional pending a clean physical print.

## Self-test

```ts
import { SELF_TEST_STEPS, alignmentBitmap, patternBandsBitmap } from "@cobblr/thermal-print";
// SELF_TEST_STEPS: alignment → patterns → qr  (the QR target is rendered by the caller)
```

## Profiles

```ts
import { matchProfile, KNOWN_PROFILES, CANDIDATE_SERVICES } from "@cobblr/thermal-print";
const profile = matchProfile(device.name); // by advertised-name prefix, or null
```

Add a model in `src/profiles.ts` (+ a test) once confirmed. `CANDIDATE_SERVICES`
is the list a Web Bluetooth `requestDevice` must pass as `optionalServices`.

## Web Bluetooth transport (browser)

```ts
import { requestPrinter, connectAndDiscover, printBitmap, CANDIDATE_SERVICES } from "@cobblr/thermal-print";
const device = await requestPrinter([...CANDIDATE_SERVICES]);
const { writeChar, tree } = await connectAndDiscover(device);  // first writable char + full GATT tree
await printBitmap(writeChar, alignmentBitmap(320), { density: 8 });
```

Browser only, and only from a top-level secure context (a first-party page or the
standalone site — NOT a sandboxed iframe, which strips the `bluetooth`
permission-policy). iOS has no Web Bluetooth.

## Develop

```bash
npm run typecheck
npm run test      # 26 unit tests (protocol framing, self-test bitmaps, profiles)
npm run build     # → dist/ (gitignored)
```
