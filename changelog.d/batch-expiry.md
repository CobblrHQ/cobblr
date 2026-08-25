---
type: feature
scope: inventory
date: 2026-08-23
docs_target: docs/USER_GUIDE.md#3.1 Inventory
---
**Several of the same thing bought on different days now each keep their own use-by date.** Four meals in the fridge, two from Sunday and two from Wednesday, are no longer one date pretending to cover both. You are told about the oldest one, the rest are left alone, and once you have eaten it the warning moves on to the next by itself. Everything you already track carries on working unchanged; nothing needs re-entering.

## docs

### Several of the same thing, bought at different times

If you buy the same thing more than once, the ones you bought later keep later dates. Four containers of the same meal, two from Sunday and two from Wednesday, are two lots rather than one number with one date.

You mostly will not see this. The item still shows a single count and a single use-by, and that use-by is always the **soonest** one, because that is the one worth acting on. What it means in practice:

- **You are told about the oldest.** The rest are fine and are not mentioned. A warning that named everything in your fridge would be one you stopped reading.
- **Eating one moves the warning on.** Once the urgent lot is gone the next date takes over by itself. Nothing to update.
- **Adding more never hides an older one.** Putting fresh stock in cannot push an existing deadline out of sight.

To see the detail, open the item. The lots are listed oldest first:

```
2 received 18 Aug, use by today
2 received 21 Aug, use by 28 Aug
```

Anything you were already tracking keeps working exactly as before. An item with no use-by date does not get one invented for it.
