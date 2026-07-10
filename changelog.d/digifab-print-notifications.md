---
type: feature
scope: digifab
date: 2026-06-18
---
**Live print updates in Discord, with the webcam snapshot, the ETA, and one post instead of two plugins.** As a job runs, the farm posts to Discord (or in-app, or email): **started → 25 / 50 / 75 % → finished / failed**, as a rich, colour-coded card with **Progress**, **Remaining**, **Elapsed**, and **Filament**, the **live webcam snapshot** embedded right in the post, and a **Live view** link to the feed, the OctoEverywhere experience, in one message. Set it up once at **Me → Notification channels**: add `digifab.print.*` (or `*`) on the **Discord** channel with your server's webhook URL. The snapshot works wherever Cobblr can reach the camera (a self-hosted instance on the same network as the printer); everything else (the card, ETA, links) works everywhere. A failed print comes through as a red, high-priority alert.
