---
type: feature
scope: fields
date: 2026-08-22
docs_target: docs/USER_GUIDE.md#4.5 Custom fields
---
Sets of fields you can switch on in one click, starting with Provenance: where each thing came from, when, and what it cost.

## docs

Some fields are worth having on everything you own, and building them one at a
time gets tedious. On the Fields page there is now a short list of **sets you can
switch on**.

The first is **Provenance**: *Acquired from*, *Acquired on* and *Paid*, added to
every physical thing you track. They are plain fields, so a receipt can put a
shop name in *Acquired from* whatever that shop is called. Turn it on and they appear on all of them,
including kinds you add later.

The reason it is a switch and not something you build by hand is what the fields
KNOW. Each one is tagged with its meaning, so when you scan a receipt, the date
printed on it goes into *Acquired on*, the shop goes into *Acquired from*, and
the price goes into *Paid*. A field you build yourself has no meaning attached,
so nothing fills it for you.

You can give your own fields a meaning too. The new-field form has a **Meaning**
dropdown ("When it became yours", "What it cost", "When it expires", and so on).
It is optional, and leaving it blank is fine for a field you only ever type into
yourself.

Turning a set off removes its fields. Anything already recorded stays on your
items and comes back if you turn the set on again.
