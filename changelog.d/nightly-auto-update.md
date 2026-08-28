---
type: selfhost
scope: deploy
date: 2026-08-27
---
The standalone stack can keep itself up to date: add the `autoupdate` profile to `COMPOSE_PROFILES` and a small updater checks for newer images every four hours and restarts only the Cobblr containers that changed. About one build is published a day, so that is about one restart a day, and no fixed hour has to suit every timezone. WATCHTOWER_SCHEDULE takes a cron expression if you would rather pick the moment. Off by default, and it pairs with the nightly channel.
