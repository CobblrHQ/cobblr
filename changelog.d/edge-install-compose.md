---
type: improvement
---
The edge-bridge install step now offers a **docker compose** snippet alongside the `docker run` command — toggle between them and copy whichever fits how you run things.

Also: when you connect a printer through a manager or edge bridge, Cobblr now **back-propagates the name** to the New-printer form (the name you gave the machine), **auto-selects** the printer when there's only one (so the link actually gets created), and on a printer's detail it **pre-chooses** the manager/printer when there's only one — no more sitting on "choose…".
