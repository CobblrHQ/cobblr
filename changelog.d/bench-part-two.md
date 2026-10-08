---
type: feature
scope: digifab
date: 2026-10-07
docs_target: docs/USER_GUIDE.md#Electronics bench instruments
docs_published: 2026-10-08
---
Added logic analyser captures and Riden supply readings, with ESPHome connections and optional confirmed supply control.

## docs

Connect a sigrok logic analyser, a Riden supply over USB or Modbus TCP, or an owner-configured ESPHome device from Devices. At its machine station, choose a board or test record to save measurements with their units. Logic captures include decoded protocol text and a downloadable .sr session for PulseView. You can also import a .sr session.

Supply control starts off. The workspace owner can enable it for an instrument; output-on and each set point need confirmation and are logged. Output off stays available without confirmation and checks the instrument's readback.

ESPHome devices use their native API and an encrypted device API key. Configure and flash them in ESPHome, with Wi-Fi values in its secrets.yaml. Cobblr does not collect those values. Wiring, the ESPHome configuration and bridge prerequisites are in the [bench instrument guide](modules/bench-instruments.md).
