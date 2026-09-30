---
type: feature
scope: files
date: 2026-09-30
docs_target: docs/USER_GUIDE.md#3.4 Files (foundational)
---
**PDFs and design files can be much bigger now.** A scanned pattern PDF, a STEP or STL model, a 3MF or a gcode file can be up to 200 MB on your own server (100 MB on the hosted app), where every file used to stop at 25 MB. Photos, videos and other files stay at 25 MB. A file over its limit says how big it is and what the limit is for that kind of file. Big uploads are also easier on the server, which now writes them to disk as they arrive instead of holding them in memory. And when a phone loses signal partway through, the page now says the upload was cut off and to try again on a steadier connection, instead of "Load failed".

## docs

**How big a file can be** depends on what it is:

- **PDFs and design files** (`.pdf`, `.step`/`.stp`, `.stl`, `.3mf`, `.obj`, `.amf`, `.gcode`/`.bgcode`, `.dxf`, `.svg`): up to 200 MB on a self-hosted server, 100 MB on the hosted app. A server owner can change it with `COBBLR_UPLOAD_DESIGN_MAX_MB` (25 to 1024).
- **Everything else** (photos, videos, documents): up to 25 MB.

What counts is the kind of file, not just its name: a video renamed to `.pdf` is still held to 25 MB. A file over its limit is refused with a sentence that names its size and the limit, like "This file is about 230 MB; PDFs and design files can be up to 200 MB." A zip is judged file by file the same way, and its report names each file that was too big.

If the connection drops partway through an upload, you see "The upload was cut off before it arrived. Try again on a steadier connection." Nothing half-sent is kept.
