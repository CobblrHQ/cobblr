---
type: fix
scope: account
date: 2026-08-22
---
Adding a connection now really has the provider it says it has. The picker showed the first provider in the list, but the form underneath had not actually chosen it: there was no API key field, the note said the provider needed no credentials, and Save did nothing until you re-picked the provider that was already on screen. Choosing any provider from the menu had always worked; it was only the one shown on arrival that was for show.
