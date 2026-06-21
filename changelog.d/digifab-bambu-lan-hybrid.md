---
type: feature
---
**Bambu LAN, as a setting on the printer.** Open a Bambu printer in digifab → **LAN access** → enter its IP + access code, and Cobblr adds a LAN transport to the *same* printer (no second connection). Cloud keeps doing live telemetry; **file-push** (sending an arbitrary sliced file — which cloud can't do) and control now route through your on-site edge bridge over the printer's LAN. (Live camera over LAN is a follow-up — it needs an RTSP update in the bridge.)
