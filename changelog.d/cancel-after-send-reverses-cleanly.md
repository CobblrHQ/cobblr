---
type: fix
date: 2026-09-13
---
Cancelling a print job right after sending it now always puts the build's materials back and removes the output credit. The reversal could race the send's own stock movement and lose, leaving output credited for a print that never happened.
