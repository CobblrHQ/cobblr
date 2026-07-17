---
type: feature
scope: inventory
date: 2026-07-17
docs_target: none (written straight into docs/USER_GUIDE.md in this PR, beside the stock-vs-catalog note it follows on from)
---
When you track serial numbers for something you also count, Cobblr now keeps both numbers instead of pretending they are one. While you are scanning serials in, the item just notes how many are not scanned yet. If the two numbers are still apart once you have stopped, it asks which is right rather than guessing, and taking the serials as the truth lands as a normal stock change with a line in the item's history.
