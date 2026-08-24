---
type: improvement
scope: notifications
date: 2026-08-24
---
When Cobblr moves to a new Discord app, your linked account no longer goes quietly unreachable. A Discord DM belongs to the bot that sent it, so a new app has to earn its own permission to message you, and previously nothing noticed: notifications simply stopped arriving while the settings page still said Discord was connected. Your communication settings now say the app changed and offer one re-confirm, and notifications wait in the bell until it is done rather than being sent into a channel nobody is listening on. If Discord ever blocks messages from us outright, the connection is marked unverified instead of silently swallowing everything after it.
