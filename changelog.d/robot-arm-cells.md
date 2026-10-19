---
type: feature
scope: digifab
date: 2026-10-17
docs_target: docs/user-guide/digifab.md#3.19 Digital Fabrication (`digifab`, stock)
---

Cells: a CNC and the arm that unloads it run as one job on the shop bridge, started at the cell, with every step recorded, its parts counted into stock and its operators told when it pauses.

## docs

**Cells.** A cell runs machines that work together, like a CNC and the arm that unloads it, as one job on your shop's bridge. Add a **Cell: machines that run as one job** to the bridge beside its machines, then open a machine record for the cell and choose **Set up as a cell**. Give it its machines, each with a role such as cnc or arm (an arm must be set up as a robot arm first), and its job steps: run a file already on a machine, run an arm program, wait for a machine to be idle, or wait for a sensor reading, each with the longest it may take. Say how many cycles to run, or until stopped, and how many parts a cycle makes. Name its operators, who start it and are told when it pauses, and the inventory part its parts go to. Start the job at the cell's station: tick that the cell is clear, guarded and ready to run this job, then **Start the cell**. Start is sent once. While the job runs, its machines take no other work from Cobblr. If a step fails or takes too long, the bridge pauses every machine that can pause and the operators are told why. A timeout can be resumed at the station once someone has looked; a fault is cleared at the machines, and the job stopped. **Stop cell** works from the record, the station or Cobb. Each finished cycle adds its parts to stock once. Cobblr never sends a step itself or moves a machine, and a cell is not a safety function.
