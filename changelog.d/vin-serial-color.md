---
type: fix
scope: core-scan
date: 2026-07-14
---
Fixed two things a scanned vehicle got wrong. The **VIN field stayed empty** after a VIN scan, and was still labelled "Serial number", even though the Vehicles bundle relabels it to VIN and declares that it holds the VIN. Two causes: the confirm form's built-in fields were hardcoded, so a bundle's relabels never reached them (every other form already reads them), and the fill planner recognised the "this field holds the code" role and then ignored it. The VIN now lands in the VIN box, and the box is called VIN. Separately, the **colour was invented**. A silver van came back as a blue-grey hex, because vision was asked what colour the car was and duly made up six hex digits. A colour resolved from the paint code stamped on the vehicle's own label now wins over the model's guess, and the photo pass is asked to read paint and colour codes off labels alongside the serial numbers it already reads.
