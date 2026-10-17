---
type: feature
scope: digifab
date: 2026-10-16
docs_target: docs/USER_GUIDE.md#3.19 Digital Fabrication (`digifab`, stock)
docs_published: 2026-10-17
---

Robot arms are machines: an arm's page shows its controller's connection, mode, program and safety state, keeps its programs by revision and family and what it is known to work with, and its station loads, starts, pauses and stops programs. Cobblr never moves an arm or clears a stop. Robot arms are a part of Digital Fabrication you can switch off in Configuration, Modules: features can now have parts, and an off part's screens, actions and assistant tools disappear while everything it recorded is kept.

## docs

Add **Robot Arms** from the bundles to keep your arms in their own tab. Open
an arm's record and choose **Set up as a robot arm**. With no controller
connection it keeps records only: the programs it runs, its service state and
what it is known to work with. To follow the controller, choose the arm on
your shop's bridge. The **Robot arm** panel then shows five things separately:
whether the controller answers, its mode (remote, or local when the pendant
has control), the program and whether it is loaded, running, paused or
stopped, its safety state (normal, protective stop, emergency stop or fault),
and whether the arm is in service or down for repair.

**Read the controller again** reads its model, serial, software versions and
the programs it holds. Each program is kept with its revision, on that arm. A
changed revision is a new program record, and one the controller stops
listing stays, marked as no longer listed. Group programs that do the same
job on different arms into a **family** ("unload CNC 3"). A controller that
cannot list its programs gets them typed by hand. **Record what works** keeps
the controller generation, firmware, options, interfaces and whether it was
tested on a simulator or on this hardware.

**Pause** and **Stop program** are on the arm's page for every member, and
Cobb can send them too. They go out whatever the arm reports. **Open arm
station** works in a browser or tablet at the cell. An owner or admin
authorizes that screen; an operator, owner or admin then loads a program,
confirms the cell is clear and starts it. Start is offered only when the
controller reports that program and revision loaded, in remote mode, with its
safety normal. Every command, and who sent it from where, is listed on the
arm. Cobblr never moves an arm, clears a protective or emergency stop, or
changes safety settings: do those at the pendant. See
[Robot arms](https://github.com/CobblrHQ/core/blob/main/docs/modules/digifab-robot-arms.md).

**Configuration → Modules** lists the parts of each feature that has them, such as **Robot arms** in Digital Fabrication. Switch a part off and its screens, actions and the assistant's tools for it disappear for everyone in the workspace; everything it recorded is kept, and switching it on again shows all of it. **Use default** lets a part follow its own rule again: Robot arms is on wherever the workspace has the Robot Arms collection. Cobb can switch a part too ("turn on robot arms"), and a workspace's choices travel in its blueprint.
