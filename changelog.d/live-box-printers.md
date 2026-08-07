---
type: feature
scope: labels
date: 2026-07-29
docs_target: docs/USER_GUIDE.md#Printers
docs_published: 2026-08-07
---
The Live box now shows the printers your edge bridge is holding, from any page: whether each is connected, idle or printing, its loaded roll and battery, and buttons to connect, disconnect or check it.

## docs

### Printers in the Live box

If you run an edge bridge, the Live box (bottom right, or in the sidebar foot)
shows a printer row. Its ring lights up when the bridge is holding a link open,
so you can tell from any page whether a printer is ready to print immediately.

Open it and each printer the bridge has gets a card: what it is doing, the roll
and battery it last reported, and the buttons that make sense for it.

- **Connected** means the bridge is holding the link open. Printing is instant,
  and it stays that way when you refresh, navigate, or close the tab, because
  the bridge is a separate app on your computer rather than something the page
  is holding. **Disconnect** lets it go.
- **Idle** means the printer is reachable but nothing is held. Printing still
  works, it just opens the link first. **Connect** holds it open.
- **Ready** means that printer is set up to open a link for each job. That is a
  valid way to run one, so there is nothing to connect; set `keepOpen` on the
  instance in your bridge config if you would rather hold one.
- **Not answering** means the bridge is fine but the printer did not pick up,
  which is almost always powered off or out of range.

If no bridge is running, no row appears at all. Nothing is wrong; that is simply
the normal state for a browser-only setup.
