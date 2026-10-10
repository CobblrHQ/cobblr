---
type: feature
scope: ai
date: 2026-10-08
docs_target: docs/USER_GUIDE.md#3.22 AI providers & the AI kill-switch (operator)
docs_published: 2026-10-10
---
You can now choose your own AI for each kind of work on Your account, Connections, such as Gemini Flash Lite for reading scans and Claude Sonnet for chat, with fallbacks, and every workspace you use follows it unless that workspace chose its own.

## docs

**Who answers for you.** On **Your account, Connections**, **Who answers for you** has one row for each kind of work: **Reading photos**, **Chat**, **Organising and text** and **Search**. Under each name it says what waits if nothing answers.

Each row reads as a chain: the AI asked first, an arrow, then each fallback, for example "Gemini · Flash Lite → My Claude · Haiku · latest (5.5)".

- **Tap a row** to change it. **First** is the AI asked first: one of your own connections and a model it can do that work with. A connection that cannot read images is not offered under Reading photos, and only the models that connection serves for the work are listed.
- For a connection that lists its own models, such as a Claude key, each family's **latest** comes first ("Haiku · latest (5.5)"), then the exact versions. Latest moves to each new version the day the provider lists it; a version you pick stays put. **Refresh models** asks the provider again now.
- **Add a fallback** adds a **Then** step, asked when the one before it is busy or failing. Drag a step by its grip, or use the arrows, to change the order, and the cross to remove a step.
- **Tap a connection's name** to mark every row it answers in. Tap it again, or **Show all**, to clear the marks.
- **Choose your own** starts a row. A row you have not set leaves each workspace to use its own order, as before.

Personal documents are not on this list: they are always read on the device or by a local AI.

These are yours, and they follow you: every workspace you use asks them for your calls, including the scans you make, unless that workspace chose its own AI for that kind of work on its AI page. The row then says "Workspace name uses its own order". If you own or run that workspace, **Use my defaults there** clears its own choice for that kind of work, so your calls there follow yours. Members who set nothing keep getting the workspace's own order.

When every step in your row is unusable (a connection removed, or one that cannot do the work), the call stops and says "None of your defaults for Reading photos could answer", naming each step and why. It never quietly falls back to an AI you did not pick. Each change is recorded in the activity of every workspace you use.

On a workspace's AI page, under **Who does what, in order**, your own steps show as yours, with a link back here to change them.

You can also ask Cobb, or an assistant connected over MCP: "use Flash Lite for scans" sets your Reading photos row, and "use Haiku for chat" picks Haiku's latest.
