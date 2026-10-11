---
type: feature
scope: core-scan
date: 2026-10-11
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
---
A forwarded order is read on the store's own page: each line takes its variant's photo, and a mixed pack like "10KG / Multicolor" becomes its ten spools, one per colour, each matched on its own against what you already have.

## docs

**An order line is read on the store's own page.** When an order email names a variant ("KINGROON PETG Filament 1.75mm - US / 10KG / white") and the store publishes its products, Cobblr reads that product's public page. A forwarded email counts as coming from the store that sent the original. Each line takes its variant's own photo when the email printed none, and the card says **Catalog: from the store's page**.

**A mixed pack becomes its spools.** A line for a pack of several colours ("10KG / Multicolor", ten 1 kg spools) becomes one line per colour, each named the way the store sells that colour on its own and carrying that colour's photo. Each is then matched against what you already have, so your white spool gets one more only from a pack that holds white, and the rest are new. The line's price is shared across them to the cent. The colours are chosen from the store's own colour names by reading the pack's photo once. A spool it is unsure of, or names in a colour the store does not sell, becomes its own line called **colour unknown**, with the pack's photo, for you to correct like any other line; it is never guessed and never dropped.

**When the page cannot be read** (the store asks for a sign-in, it is not a store whose products can be read, no model is available, or the read names none of the store's colours), the pack stays one line of ten and the card says **Which colours the 10 are could not be read, so they stay together**, with the reason on hover. It never counts as one.

Read again reads a split pack fresh. The pack shows in **Recently committed** as split into its spools, and **Undo split** there puts it back as one line.
