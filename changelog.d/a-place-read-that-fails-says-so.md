---
type: fix
date: 2026-10-05
---
**Scanning something kept in several places never guesses the place.** When Cobblr could not read where an item is kept, a scan could add to whichever place it found first, and picking the right place could be refused. It now says it could not check and asks you to try again.
