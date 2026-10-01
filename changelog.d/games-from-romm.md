---
type: feature
scope: core-documents
date: 2026-10-01
docs_target: docs/USER_GUIDE.md#3.4 Files (foundational)
---
Your games in RomM now show up on the cartridges and discs they belong to. Connect RomM under Your account → Connections → Add a service, and each game you own gets its ROM matched by title and platform, or by IGDB id, with its cover, its platform, whether it plays in RomM, and a link to open it there.

## docs

### Games from RomM

If you keep your retro games in RomM, Cobblr can link each ROM to the
cartridge or disc on your shelf. Nothing is copied: Cobblr links to the game
where it is.

**Connect RomM.** Your account → Connections → Add a service → RomM. Give its
address and a Client API token (in RomM: Administration, Client API tokens; it
starts with `rmm_`). If RomM runs on your home network and Cobblr does not,
choose **Through my bridge**.

**On every record.** The **From your libraries** panel gets a **Games**
section. Cobblr matches your games in the background:

- by **platform and title**: give a cartridge a `platform` field ("SNES",
  "Game Boy Advance") and it is only offered the ROM for that platform, never
  the port of the same game for another;
- by **IGDB id**: give a record an `igdb_id` field and it finds its ROM even
  when RomM calls the game something else.

Each game shows its cover, its platform, **Playable in RomM** when RomM can run
it in your browser, and **Open in RomM**. Press **Link** to keep it.

RomM has no place to keep a link back to Cobblr, and Cobblr never copies a
ROM, so those two options do not appear for it. New games you add to RomM are
matched once a day.
