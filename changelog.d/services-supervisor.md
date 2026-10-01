---
type: feature
scope: services
date: 2026-09-29
docs_target: docs/USER_GUIDE.md#4.3 Wires (connecting events to actions)
docs_published: 2026-10-01
---
Cobblr now keeps an eye on the services it runs for you. A service that stops answering is checked on and handed to the next one in your order, a job waiting for your yes gets a reminder before it expires, and a run that gets stuck sends you one notice with Retry, Skip and Cancel. Every run has its own page showing each step and what it is waiting on.

## docs

**When a run gets stuck.** Cobblr watches every job a service is doing. If a service goes quiet (no progress for ten minutes, or much longer than the job usually takes), Cobblr asks it once more, then hands the job to the next service in your order under **Who does what, in order**. Something that acts in the real world, like a print, is never handed to a different machine: it stops and tells you instead.

You get one notice per stuck run, in the bell and on Discord if you have it set up:

- **Retry** runs the step again with exactly the same input.
- **Skip this step** lets the run go on without that step's answer. It only appears when the next step can do without it.
- **Cancel** stops the whole run.

A job waiting for your yes gets a reminder a few hours before it would be cancelled, unless you already opened its card. A question a service asked you gets a reminder after a day.

**Service runs.** Open **Recent runs** under Who does what, in order (or **See the whole run** on any job card) to see every run: stuck and waiting ones first. A run's page lists each step, which service did it, and what it is waiting on.
