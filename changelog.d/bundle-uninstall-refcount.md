---
type: fix
scope: bundles
date: 2026-06-21
---
Uninstalling a bundle now cleans up after itself properly. The tables a bundle added (e.g. a Yarn, Hooks, or Designs list) are removed, and any module it switched on is switched back off: **but only when nothing else still needs it**. If another installed bundle shares that module, or you turned it on yourself, it stays. The Remove dialog now tells you exactly what will go ("deletes Yarn (12 items), Hooks and turns off Inventory") before you confirm. Previously the bundle's lists and modules were left behind, lingering in your sidebar.
