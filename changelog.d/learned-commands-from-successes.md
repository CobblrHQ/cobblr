---
type: feature
scope: ai
date: 2026-08-19
docs_target: docs/USER_GUIDE.md#2. Core concepts
---
Cobblr now remembers which message produced which change, so a thing you asked for once can become something your workspace does on its own. Ask for twelve racks and the twelve records that appear are recorded together with the sentence that asked for them, then generalised into a reusable command with the numbers and names as blanks to fill in.

## docs
Every change Cobb makes is now recorded alongside **the message that asked for it**, and one message that produces several changes is kept together as a single example. From those, Cobblr works out reusable **commands**: "make rack 1 through 12 in Den" becomes "make rack {from} through {to} in {parent}", which runs again on any numbers and any place, with no AI involved. Only examples it can fully explain become commands: if the numbers you asked for are not both written in your message, or one message did two unrelated things, nothing is learned, because a command that fires on the wrong sentence would write to your workspace. A single command is capped at 200 records so one sentence can never run away with your data.
