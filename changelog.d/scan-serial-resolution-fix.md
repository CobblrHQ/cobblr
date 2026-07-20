---
type: fix
date: 2026-07-20
---

Scanning a serial number now opens the record it belongs to. Filtering on a native column (serial number, model number, and the rest) matched nothing at all, so a scan rule pointing at a serial reported every part as missing. Serials now also match regardless of case, since scanners report whatever the keyboard layout gave them. When a serial belongs to more than one item, Cobblr asks which one you are holding instead of quietly opening the first.
