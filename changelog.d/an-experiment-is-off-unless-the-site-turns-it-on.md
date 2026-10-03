---
type: selfhost
scope: settings
date: 2026-10-03
---
Experimental features are now off on every install, yours included, until you turn them on: name them in COBBLR_FEATURES_ON and restart the api. The first is suggestions.tidy (nightly tidy-up suggestions). Until it is named, Settings does not show Tidy, the api refuses to turn it on, and the nightly does nothing. COBBLR_FEATURES_OFF still turns any feature off, and wins over COBBLR_FEATURES_ON.
