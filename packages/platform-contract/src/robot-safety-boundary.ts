// The safety boundary for robot arms and cells, in one place: the words a
// person reads on every arm and cell page (/safety/robot-arms), and the
// guards that keep Cobblr on its side of the line, each with the code that
// enforces it and the test that proves it. The design decision behind it is
// docs/design-decisions/robot-arm-safety-boundary.md; a test checks that
// every guard named here exists in the code and in that document.

export interface BoundarySection { heading: string; body: string }
export interface BoundaryGuard { guard: string; enforcedIn: string; provedBy: string }

export const SAFETY_BOUNDARY = {
  title: "Cobblr and safety",
  summary: "Safety lives in the robot's controller, its safety PLC and the cell's safety devices, and in the integrator's risk assessment. Cobblr and its bridge are not safety-rated and are never part of a safety chain.",
  sections: [
    { heading: "Where safety is", body: "Emergency stops, protective stops, light curtains, safeguards, enabling devices and collaborative limits are the controller's and the cell's safety devices. They are designed, wired and validated by the integrator under the robot standard (ISO 10218-1 and -2) and, for a robot working beside people, the collaborative technical specification (ISO/TS 15066). Nothing in Cobblr replaces or relaxes any of them." },
    { heading: "What Cobblr does", body: "Cobblr coordinates: it asks an arm's manager on the shop bridge to load, start, pause, resume or stop a program the controller already holds, and records what the arm reports. The bridge speaks the controller's protocol. A person approves each run at the cell, and the pendant always has the last word." },
    { heading: "What Cobblr never does", body: "It never moves an arm, jogs it or frees it to be pushed by hand; never releases a brake; never clears a protective or emergency stop; never changes a safety setting; and never writes a controller's installation, where its safety settings live. A Stop from Cobblr is a program stop through the controller, not an emergency stop." },
    { heading: "What it means at the cell", body: "Treat Cobblr's Stop as a convenience, never as the way to make the cell safe: use the cell's own emergency stop. Clear every stop at the pendant after checking the cell. A cell job pauses and tells people when something fails, but it is not an interlock: the guards and stops of the machines in it are." },
  ] as BoundarySection[],
  guards: [
    { guard: "No operation that moves an arm, frees it, clears a stop or changes safety is in the command contract", enforcedIn: "packages/platform-contract/src/robot-arm.ts", provedBy: "packages/platform-contract/src/no-forbidden-operation-fits-the-arm-command-contract.test.ts" },
    { guard: "Pause and stop reach an arm from anywhere; everything that makes it do more needs a person at its authorized station", enforcedIn: "modules/digifab/src/families/arms/control.ts", provedBy: "modules/digifab/src/families/arms/only-pause-and-stop-reach-an-arm-without-its-station.test.ts" },
    { guard: "The pendant always wins, and one station controls an arm at a time", enforcedIn: "modules/digifab/src/families/arms/rules.ts", provedBy: "modules/digifab/src/families/arms/one-station-controls-an-arm-and-the-pendant-always-wins.test.ts" },
    { guard: "A run starts only from a person's approval at the cell, bound to the program revision and the tooling", enforcedIn: "modules/digifab/src/families/arms/rules.ts", provedBy: "modules/digifab/src/families/arms/a-run-approval-holds-only-for-its-arm-revision-and-tooling.test.ts" },
    { guard: "A start whose answer was lost is never sent again", enforcedIn: "modules/digifab/src/families/arms/runs.ts", provedBy: "modules/digifab/src/families/arms/a-lost-start-is-reconciled-by-reading-the-arm-never-resent.test.ts" },
    { guard: "A replayed event never becomes a command", enforcedIn: "modules/digifab/src/families/arms/runs.ts", provedBy: "modules/digifab/src/families/arms/a-replayed-arm-event-changes-nothing-and-moves-nothing.test.ts" },
    { guard: "A changed program runs only once a person has released it", enforcedIn: "modules/digifab/src/families/arms/programs.ts", provedBy: "api/tests/a-changed-arm-program-runs-only-once-released-and-a-backup-is-proven-by-a-restore.test.ts" },
    { guard: "A restore writes programs only, never the installation with its safety settings", enforcedIn: "packages/platform-contract/src/robot-arm.ts", provedBy: "api/tests/a-changed-arm-program-runs-only-once-released-and-a-backup-is-proven-by-a-restore.test.ts" },
    { guard: "A cell job starts only at its station, bound to the job and each arm's tooling, and a fault never resumes", enforcedIn: "packages/platform-contract/src/robot-cell.ts", provedBy: "packages/platform-contract/src/robot-cell.test.ts" },
    { guard: "Every command to an arm or a cell is recorded with who sent it and from where", enforcedIn: "modules/digifab/src/families/arms/control.ts", provedBy: "api/tests/an-arm-stop-is-sent-whatever-the-arm-reports.test.ts" },
  ] as BoundaryGuard[],
} as const;
