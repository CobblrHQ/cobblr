---
type: fix
scope: digifab
date: 2026-06-18
---
**Print jobs honour printer tags on every farm — and won't land on the wrong machine.** A job targeted at a tag (e.g. your "PLA" group) now resolves to a real printer **inside Cobblr** before it's sent, so it works the same on every connected farm — including FDM Monster's classic submit, which used to ignore the tag and let the farm route the file wherever it liked. And if a job points at a printer that isn't on its connection (a stale or mixed-up id), the send is **refused** with a clear error and the job is left in the queue to re-target, instead of silently printing on whatever machine happened to share that id.
