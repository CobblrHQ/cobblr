---
type: improvement
scope: core-scan
date: 2026-09-07
---
**An item with no picture keeps looking for one on its own.** A scanned item whose picture search came back empty used to stay blank until you pressed retry, even when the photo strip under it was full of good options. Now any pending item without a picture is asked again in the background: right away once the web search is answering again if it had refused, and otherwise every six hours for a week. A picture you chose by hand is never replaced.
