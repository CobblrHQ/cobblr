---
type: fix
scope: core-scan
date: 2026-07-24
---
**A forwarded order-confirmation email now parses into its individual line items, and the reply is from a clean address.** Emailing in a real store order (which has no "2x"/"qty:" shorthand) was being flattened into one useless catch-all item instead of one row per product. Emailed receipts now always run through the receipt parser, so each line becomes its own inbox row under the receipt session. Separately, the reply you get now shows a tidy "Cobblr" sender instead of a long signed address, while replies still route back to your workspace.
