---
type: fix
---
The edge-bridge setup now **names the bridge** it's reporting on ("the garage bridge is online ✓" vs a vague "your bridge"), since you can run several. The Bridge-id field is clearer too: blank = your main bridge (installed without a BRIDGE_ID), and any additional bridge must be named so it gets its own channel.
