---
type: feature
scope: core-print
date: 2026-07-13
docs_target: none (USER_GUIDE.md core-print modules row updated inline)
---
Printers can now reach a CUPS printer on your LAN from a **hosted** Cobblr through the on-site **edge bridge**. Add Printer's manager field is now a **"how Cobblr reaches it"** chooser: **Direct URL** (self-host or same network, as before) or **Via edge bridge**. Install a bridge inline if none is running yet, or pick a connected one, and Cobblr hands the print job to the bridge, which speaks IPP to CUPS locally. The bare URL box that promised an edge bridge with no way to set one up is gone, and a hosted direct-to-LAN address now explains the fix ("run an edge bridge") instead of failing with a raw SSRF error.
