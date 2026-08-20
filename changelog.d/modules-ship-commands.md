---
type: feature
scope: ai
date: 2026-08-19
docs_target: docs/USER_GUIDE.md#2. Core concepts
---
A brand-new workspace already knows how to do a few things, with no AI connected and nothing taught to it. Modules now ship the sentences their users commonly type, so "make Shelf 1 through 4 in Garage" works on day one, and one command covers shelves, bays or bins alike. A command your own workspace learned can also be exported as the snippet to contribute it back, so something that turns out to be common can ship for everyone instead of being taught again in every workspace.

## docs
Modules ship commands of their own, so **Configuration → Assistant** already lists a few under **Things this workspace can do on its own** before you have taught it anything, each labelled with the module it came from. Locations ships "make {label} {from} through {to} in {parent}", which numbers a run of shelves, bays or bins inside a place you name, and "add a place called {name} in {parent}". They work with no AI connected at all. A command your workspace learned for itself has an **export** that gives you the snippet to contribute it back, so if it turns out to be something everybody wants it can ship in the module rather than being taught again in every workspace. Nothing is uploaded: the export is text for you to read and share if you choose. Creating a place now also accepts the parent **by name** ("in Garage"), and says so plainly when no place by that name exists, instead of quietly creating it at the top level.
