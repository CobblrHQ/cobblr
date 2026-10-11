---
type: feature
scope: core-scan
date: 2026-10-11
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
ui: none (the card already shows a scan's note, where the label's words go, and the pack lines, Split off and rename are the existing controls)
---
A photo of a filament box's label now names the spool and counts it toward its order with no AI, and a mixed pack whose contents are known splits into them with no AI.

## docs

**A box's label is read before any AI is asked.** Photograph the label on a spool's box while an order it belongs to is open, and the inbox reads its colour, part number and batch off the label itself. It then counts the box toward that order: one of the units of a line of the same thing, or the matching spool of a split pack, which takes the box's batch. The card says what the label said and that no AI was asked. A label it cannot read clearly enough goes to the usual photo identify, so a box is never guessed into a colour: "Green" is never "Grass Green", and a part number has to be the store's own for that colour. A batch number is kept only when it reads the same twice.

**A pack whose contents are known splits with no AI.** Kingroon's 10 kg PETG "Multicolor" and "Multicolor-1" packs are known spool by spool (read off one owner's boxes), so either one splits into its ten colours straight from the order, each with the colour its box prints and its part number.

**A pack's spools are one line per distinct thing.** Four white spools in a pack of ten are one line of four, filed as four more of the one white record, beside six lines of one: seven lines totalling ten. Rename a spool to what another spool of the pack already is and the two become one line, with their units and their price added. To re-colour one of several, **Split off…** one first, then rename it. Spools of unknown colour stay a line each, since two unknowns are not known to be the same. The lines' prices always add up to what the order line cost.
