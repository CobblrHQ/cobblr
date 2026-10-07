---
type: feature
scope: fields
date: 2026-10-02
docs_target: docs/USER_GUIDE.md#Saying what a field means
docs_published: 2026-10-08
---
A vehicle fills its empty Model and Year from its name and VIN, never over what you typed. Adding a field that means the same as one the kind already has is noticed before it is made, and a seller you keep noting is offered as a field of its own, once.

## docs

When a vehicle is made or its VIN changes, any empty Model, Year and Trim are filled from the VIN and from the vehicle's own name: "Yamaha YZF-R3, Blue" with Make Yamaha says the model is YZF-R3. Nothing you typed is replaced, and the year is read from the VIN itself when it is certain.

A kind keeps one field per meaning. Type a label on the Fields page and it reads what the field means ("Store" means where it came from) and asks "right?". If the kind already has a field with that meaning, it says which before anything is made, and offers to use that one or to add yours as a field of its own. Two fields that already mean one thing show one notice: keep one, and the other's values move into it, with an Undo.

Note the same seller beside where things came from a third time, or under two places, and Cobblr asks once whether to track sellers as their own field. Yes moves every seller you noted into a Seller field, with an Undo; no is never asked again for that kind.
