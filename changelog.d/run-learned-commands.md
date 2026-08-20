---
type: feature
scope: ai
date: 2026-08-19
docs_target: docs/USER_GUIDE.md#2. Core concepts
---
A workspace can now be taught to do something and then do it with no AI at all. Ask an AI for twelve racks once, and under Configuration then Assistant that becomes a command you can keep. From then on the same kind of sentence, with different numbers or a different place, offers to run itself and needs only a yes. Every change it makes is recorded and undoable exactly like one an AI made, and a sentence that does not fit is refused rather than guessed at.

## docs
**Configuration → Assistant** grows a section called **Things this workspace can do on its own**. Under **Could learn** are commands worked out from times an AI did something for you: "make rack 1 through 12 in Den" becomes **make rack {from} through {to} in {parent}**, shown with the message it came from. **Teach it** keeps it. After that, typing a sentence of that shape into Ask Cobb offers to run it, with a plain description of what it will do ("Creates 3 locations") and a **Do it** button, and no AI is asked at any point. Commands can be turned off without being forgotten, or forgotten entirely. What actually runs is worked out on the server from the command it stored, so a command can only ever do the kind of thing it was taught, and a sentence that does not fit is refused. One run is capped at 200 records.
