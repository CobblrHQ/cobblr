---
type: feature
scope: devices
date: 2026-10-04
docs_target: docs/USER_GUIDE.md#3.19½ Edge bridges (Configuration → Edge bridges)
---
Added ESPHome devices for bin lights, sensor readings and switches without Home Assistant.

## docs

In Devices, choose ESPHome and add the address of an ESPHome instance on your
bridge. Expand it to list entities or find devices on the network. Native API
keys stay in the bridge configuration.

Attach a sensor to the record it measures to see its latest reading there.
Wires can react when a record gets a device reading. Choose the device's
Services connection and light entity in a place's Light settings to light its
bin. Mapping individual LEDs requires the matching per-LED effects in ESPHome.
Switches, buttons, numbers and options use Services and ask for your yes before
running. Cobb and MCP use those same capabilities.
