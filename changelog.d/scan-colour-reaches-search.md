---
type: fix
scope: scan
date: 2026-07-30
---
Telling Cobblr an item's colour now actually changes the photos it finds. Before, a colour was only known if the thing you were filing into happened to have a colour field, which most do not, so typing a hint like "color: blue" changed nothing. Now your hint wins, the AI reports the colour it can see, and either one goes into the image search and the ranking. The photo strip also shows you the exact phrase it searched, and refreshes after a re-run instead of showing the previous results for five minutes.
