---
type: fix
scope: actions
date: 2026-09-22
---
Actions you run on a record now use that record. Setting a field on an asset, logging a measurement on a metric, sending a command to the device linked to a thing and recording a machine's hours all took their target only from a typed argument, so asking for one on the page you were looking at ran the action and changed nothing. Four more that sweep a whole table (moving a field into Location, lifting items into types, recording an order) no longer offer themselves as a button on every record; they are workspace actions, and the assistant still reaches them.
