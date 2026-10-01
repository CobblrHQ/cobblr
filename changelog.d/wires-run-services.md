---
type: feature
scope: wires
date: 2026-09-29
docs_target: docs/USER_GUIDE.md#4.3 Wires (connecting events to actions)
docs_published: 2026-10-01
---
A wire can now run one of your services when something happens, and chain one service after another. Pick **No record** and **Run a service** in the wire editor, choose the service, and fill in the form it asks for, using what the last job answered. Anything that acts in the real world, like starting a print, still waits for a person to say yes.

## docs

**Run a service from a wire.** In the wire editor, set **On which records** to **No record: once, for the workspace** and **Do** to **Run a service**. Choose the service from the list of what your workspace can call; its own form appears below, one box per thing it asks for. Each box takes a value or a `{{token}}`.

To run one service after another, set **When** to *Something happens* with the event `services.job.done`, and pick **After which service**. The form then offers the finished job's details as tokens (`{{event.capability}}`, `{{event.jobId}}`), and its answer as `{{event.output.<field>}}`, named by that service. The new job is counted as the next step of the same run.

A service that acts in the world (a print, a machine) never starts from a wire by itself: the job waits, and the workspace's owners and admins get a card with **Yes, start it**. If nobody says yes within a day, it is cancelled.
