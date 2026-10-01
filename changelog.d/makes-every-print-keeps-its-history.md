---
type: feature
scope: digifab
date: 2026-09-29
docs_target: docs/USER_GUIDE.md#3.19 Digital Fabrication (`digifab`, stock)
docs_published: 2026-10-01
---
**Every print now keeps its whole history as a Make.** What was asked for, the design, the model, the slicer and its settings, the printer and the spool, and how it came out, in order, with every file in one folder. A Make can start from your own model or G-code, can be made again from any step, and shows up on the printer's and the spool's pages.

## docs

**Makes.** A Make is one print's whole history, from what was asked for to how it came out. Open **Makes** from the Digital Fabrication page, or search for "Makes".

- **Start one** with **New make**: describe what to make, or bring a model (STL, STEP or 3MF) or G-code you already have. A Make you start from your own file begins at that step, and nothing before it is shown.
- **The timeline** lists the steps in order: Request, Design, Model, Slice, Print, Outcome. Each step says what produced it (a service and its version, your upload, the printer) and shows its files. Open a file to preview it, or open it in a new tab. The Slice step keeps the slicer's full settings, and the Print step shows the printer and the spool it used, with the grams.
- **What comes next.** When your workspace has everything the next steps need, they show as waiting. When something is missing, such as a slicer, the timeline stops at the last step it can do and offers the way on: connect a slicer, or upload the G-code you sliced yourself.
- **Make again** from any step after the first: the steps before it are kept as they were, with their files, and that step and the ones after it run again. The new Make links back to the first.
- **Outcome.** Say whether the print came out well. The bed check's verdict fills it in when you give one there.
- **Made for something.** A Make started from something else, such as an order, says what it was made for and links back to it. When it comes out well, that record can count it made.
- **Where it shows up.** Every file lives in the Make's own folder in Files. A printer's links and a spool's links list the Makes that used them, and search finds a Make by what it was, the printer, the material or how it came out.
