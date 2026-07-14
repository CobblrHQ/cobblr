---
type: fix
scope: core-ai
date: 2026-07-14
---
**Improving an AI prompt now actually reaches the photos you already scanned.** Cobblr caches every AI answer so the same photo is never paid for twice. But the cache remembered an answer by the picture it was given, not by the question it was asked, and for photo identification the question lives in Cobblr rather than in the request. So when we improved the wording of that question, nothing changed for any photo already in the cache: it kept handing back the answer the old wording produced, and there was no expiry, so it would have done that forever. The prompt is now part of what the cache remembers, so improving it invalidates exactly the answers it should. This also fixes the internal tool we use to measure whether a prompt change was an improvement, which had been quietly scoring the old prompt's answers and reporting them as the new one's. One-off effect: cached AI answers from before this change are discarded, so the next scan of an old photo pays for a fresh read.
