---
type: feature
scope: ai
date: 2026-09-28
docs_target: docs/USER_GUIDE.md#3.22 AI providers & the AI kill-switch (operator)
---
The AI page now shows who answers each kind of work in order (photos, chat, organising, search), with plain warnings when there is no backup, when a model can change under you, or when a connection cannot read photos, and you can move your own connections up or down.

## docs

**Who answers, in order.** The AI page (`/configuration/ai`) lists, for each kind of work, the AI a call asks first, then the next, and so on. A call moves on when one is busy or failing, and asks at most three. The kinds are **Reading photos** (identifying a scan, splitting a photo, picking the best picture, reading text in an image), **Chat** (Ask Cobb, building a workspace), **Organising and text** (summaries, catalog matches) and **Search**.

Each row says which AI it is, the model it will use, whose it is (yours, shared by a member, this workspace's, or your plan's) and whether its key was checked. Use the arrows to move your own connections earlier or later; the order is kept for that kind of work in that workspace. Somebody else's connection shows as theirs and cannot be moved by you.

Under each list:
- **With nobody at the keyboard** says what answers automations and background work. A "Just me" connection never does.
- **Warnings** say what would go wrong, in words: no backup ("if it is busy, scanning waits"), a floating model the provider can change without notice, or a connection that does not read photos.

**Testing a bridge.** Testing a Claude or local-AI bridge connection now reaches the bridge for real. It asks one question, then shows it a small red square and asks the colour. The connection then reads **Verified** and either **reads photos** or **doesn't read photos**, so you know whether it can stand in for scanning.

On **Your account, Connections**, each workspace your AI connections reach gets one line, such as "Reading photos: Google Gemini, then Claude bridge", with a link to change the order. A scan card that says "Answered by X; Y was busy" links to the same list.
