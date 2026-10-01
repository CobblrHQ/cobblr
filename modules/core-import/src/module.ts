// core-import — bring records into Cobblr from a spreadsheet or another
// system. A CAPABILITY (no nav noun, auto-on): it owns no records of its own;
// it parses a foreign export and fans the records out to the modules that DO
// own them (locations, inventory, tags) through their public APIs and the
// platform's writers (never a cross-module import). One source adapter per system; Homebox is
// the first (`services/homebox.ts`), Snipe-IT etc. slot in beside it.
//
// Its only tables are the import runs and their steps (what each import did,
// so it can be undone); the records themselves live with the modules that own
// them.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-import",
  version: "0.7.1",
  displayName: "Import",
  description:
    "Bring your records in from a spreadsheet or another app: your items, where they are kept and their labels.",
  icon: "download",
  band: "stock",
  autoEnable: true, // ambient capability — on for every workspace

  schema: {
    tablePrefix: "core_import_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),

  lifecycle: {
    onBoot: async () => {
      const { registerSheetImportWorker } = await import("./services/sheet-import.js");
      registerSheetImportWorker();
    },
  },

  dependencies: [],

  // AI-REACH: no kinds/actions by design. An import is a one-shot operation a
  // person drives with a file in hand; what it produces is reachable as the
  // ordinary kinds it created. Import itself is not agent-invokable, because a
  // bulk write from a file the agent cannot see is not a change anyone can check.

  provides: { entityKinds: [] },

  exposes: {
    events: [],
    actions: [],
  },

  subscribes: [],
});
