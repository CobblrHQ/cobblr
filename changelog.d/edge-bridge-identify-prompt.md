---
type: fix
date: 2026-06-24
---
Photo identification now works through the edge-bridge AI (the "Local AI / Claude bridge" path many hosted workspaces use). It was sending a bare "Describe this." prompt for image identification, so the model replied with prose the scanner couldn't read as a result — surfacing as "no vision provider configured." It now uses the same structured identify prompt the OpenAI/Anthropic providers use, so a photographed item gets identified.
