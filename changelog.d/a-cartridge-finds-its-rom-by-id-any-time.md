---
type: fix
scope: libraries
date: 2026-10-02
---
**A record finds its library item by an outside id at any time.** A cartridge given its IGDB id after RomM was connected never found its ROM when the ROM was titled differently, because that match was only tried once, when the library was first read. Now the ids a library's items carry are remembered, and a record holding one finds its item whenever it is matched. Libraries already connected are read again once to fill this in.
