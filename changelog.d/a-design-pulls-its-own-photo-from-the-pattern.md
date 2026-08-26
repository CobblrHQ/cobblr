---
type: feature
scope: projects
date: 2026-08-25
docs_target: docs/USER_GUIDE.md#3.3 Projects
---
Attaching a pattern PDF to a design now pulls the finished-object photo out of it automatically, and the "pull photo from PDF" link becomes a way to see the other images in the pattern and pick a different one. The picker was measured on 26 real PDFs before being trusted to run unasked: it now tells a photograph from a chart, a logo or a coloured diagram, and attaches nothing rather than a diagram when a pattern has no photo. Patterns exported with JPEG 2000 images, which used to come back as "no photo found", now yield their photos too.

## docs

**Pattern photo.** When you attach a pattern PDF to a design, Cobblr pulls the
finished-object photo out of it for you. If the pattern holds more than one
image, a small **other images in the pattern** control appears in the pattern &
photos panel: open it to see everything that was extracted and tap one to use it
instead. A pattern that is all charts and diagrams gets no photo attached
automatically; open the strip and choose by hand. Designs that already had a
pattern but no photo pick one up the next time you open them.
