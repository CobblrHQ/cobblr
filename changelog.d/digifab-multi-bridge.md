---
type: feature
date: 2026-06-21
---
A workspace can now run **more than one edge bridge** — a second site/VLAN, or **LightBurn**, which has to run its bridge on the LightBurn PC itself. Give the extra bridge an id in the connection setup; it gets its own tunnel channel and the machines you add are pinned to it. Your existing single bridge keeps working exactly as before (no id = the default channel).
