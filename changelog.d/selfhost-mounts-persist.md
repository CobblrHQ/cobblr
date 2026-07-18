---
type: fix
scope: self-hosting
date: 2026-07-18
---
**Self-host updates no longer discard uploads and installed modules.** The standalone self-host stack bind-mounted two folders the app never writes to, while uploaded photos and runtime-installed modules landed inside the container's own writable layer, so the documented update (docker compose pull and up) silently wiped them. The stack now points the app at its mounts (COBBLR_FILES_ROOT and COBBLR_RUNTIME_MODULES_DIR), and a CI lint asserts every shipped-stack mount targets a path the app is actually told to write to, so a dead mount can never ship again. The stack was marked inert (public images not yet published), so no known installs were affected; the README carries salvage steps for anyone who ran it anyway.
