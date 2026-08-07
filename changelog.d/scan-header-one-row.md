---
type: feature
scope: scan
date: 2026-08-01
docs_target: docs/USER_GUIDE.md#Triage → commit
docs_published: 2026-08-07
---
The scan inbox header is one row that never wraps: the counts read as a single sentence you can filter by, one box does both search and paste-to-add, and the rare actions moved into a menu.

## docs

The scan inbox (`/scan`) is **one header row + the matches**, and that row does not
wrap at any width. When space runs out it yields in a fixed order: the search box
collapses to a magnifier, button labels drop to icons, the page title goes, and
the location label truncates before anything is allowed to overflow.

The row reads left to right as **what you have · where new scans go · one box to
search or add · the camera · Live Sort · everything rare**.

**The counts are one sentence, and each number is a filter.** "8 pending · 5
ready · 3 to review · 2 waiting 2d+" are four views of the same pending items,
not four separate figures, so they read as a line rather than a row of chips. Tap
**ready** to see only the confident ones, **to review** for the ones that need a
human, **waiting 2d+** for what has gone stale. They never double-count: an item
that is named but low-confidence counts as *to review*, not as *ready*. A facet
that covers everything (69 pending, 69 waiting) hides itself rather than state
one fact twice.

**Set location** says where the **next** scan will file, and says it the same way
on a phone and a desktop. Opening it explains exactly that scope, and offers the
locations as one-tap chips. Because the setting only stamps future scans, the
same menu offers **"Also set location on the N already here"** for items already
in the inbox with no location of their own.

**One box does search and intake.** Type words and it filters the list (the bar
under it says "3 of 8 shown"). Paste a **UPC** and it offers **Add**; paste
**several links** and it offers **Add 3**; **drop a file** on it and the file's
type decides what happens, images become photo intake and a PDF or CSV becomes a
receipt. Anything ambiguous stays a search, so you cannot accidentally add
something by typing. The **paperclip** inside the box holds the same three
intakes as a menu: Photos (several at once arrive as one session), Receipt, and
Import an export.

**The camera** sits at the right on a desktop; on a phone it is already in the
top bar, so the page no longer repeats it. **Live Sort** is one tap away
throughout.

**Everything rare lives behind ⋯**, grouped by what it acts on: *this inbox*
(fill missing photos, export), *elsewhere* (things you already track with no
location), and *capture setup* (pair phone, auto-pick photos).

**Grouping and density moved down to the list they affect.** A small bar above
the items switches By session ⇄ Sorting plan and toggles list ⇄ gallery.
