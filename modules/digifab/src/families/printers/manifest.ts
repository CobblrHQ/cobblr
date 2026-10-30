// What the printers family (FDM and resin) declares in Digital Fabrication's
// manifest: its module part and its actions. Data only: src/module.ts spreads
// it in through families/manifests.ts. The part is on everywhere, as printers
// were before they had a folder of their own.
import type { FamilyManifest } from "../../core/families.js";

export const printersManifest: FamilyManifest = {
  part: {
    id: "printers",
    label: "Printers",
    description: "3D printers, FDM and resin: their own controls, finding them on the network, a resin print's washing and curing, watching a print for failure, a Bambu Lab account's live readings and print updates, the spools loaded on each printer, and Print this.",
    default: "on",
    routes: ["/resin", "/snapmaker", "/failure", "/bambu", "/print-rules", "/loaded", "/printing-profiles"],
  },
  panels: [
    { part: "printers", id: "digifab:printing-profile", surface: "entity-detail-panel" as const, target: "machines:machine", title: "Printing profile", collections: ["3d-printers"], presence: true },
    // Print this on a model file's own page (Services §14.3): the door to a
    // Make, a printer it fits, a slice, and the one yes.
    { part: "printers", id: "digifab:print-this", surface: "entity-detail-panel" as const, target: "core-files:file", title: "Print this" },
  ],
  actions: [
    {
      part: "printers",
      // UI-SCREEN: /station/machine/:connectionId/:deviceId
      id: "digifab:resin-control", changes: "records", label: "Control a resin printer", scope: "workspace", group: "more", userInvokable: false,
      runBy: "member",
      description: "Stop, pause or resume a resin printer. Stop also prevents an uploading job from starting. Any member may stop or pause; resuming needs an admin or an operator; starting a print requires its authorized station and reviewed file.",
      invokeHandler: "digifab.resin-control", effect: "physical", undoable: false,
      argsSchema: {
        connection_id: { label: "Connection", type: "text", required: true },
        device_id: { label: "Device", type: "text", required: true },
        operation: { label: "Control", type: "text", required: true, choices: ["stop", "pause", "resume"].map(value => ({ value, label: value })) },
      },
    },
    {
      part: "printers",
      // UI-SCREEN: /station/machine/:connectionId/:deviceId
      id: "digifab:resin-postprocess", changes: "records", runBy: "member", label: "Record resin print washing and curing", scope: "workspace", group: "more", userInvokable: false,
      description: "Mark a good resin print washed or cured after its stock use is recorded. Washing comes before curing. This records the physical checklist and does not operate a wash or cure machine.",
      invokeHandler: "digifab.resin-postprocess", effect: "writes", undoable: false,
      argsSchema: {
        job_id: { label: "Print job", type: "text", required: true },
        step: { label: "Finished step", type: "text", required: true, choices: ["wash", "cure"].map(value => ({ value, label: value })) },
      },
    },
    {
      part: "printers",
      // UI-SCREEN: /digifab
      id: "digifab:discover-snapmakers", changes: "records", label: "Find Snapmakers", group: "more", scope: "workspace", userInvokable: false,
      // ADMIN-ONLY: finds machines on the network; adding a connection, POST /connections, is owner or admin (bulk.ts)
      runBy: "admin",
      description: "Find Snapmakers on one LAN bridge and report which transport each machine advertises. Requires an admin. Does not pair or start a machine.",
      examples: ["find Snapmakers on the workshop bridge"], invokeHandler: "digifab.discover-snapmakers", effect: "none", undoable: false,
      argsSchema: { bridge: { label: "Bridge id", type: "text" } },
    },
    {
      part: "printers",
      group: "make",
      // UI-SCREEN: /digifab
      id: "digifab:set-failure-detection",
      changes: "workspace",
      // ADMIN-ONLY: the page's own route PUT /failure/config is owner or admin (failure.ts)
      runBy: "admin",
      examples: ["turn on spaghetti detection", "make failure detection less jumpy"],
      undoable: true,
      label: "Set print failure detection",
      description:
        "Turn print failure detection on or off, how sure it must be before it calls a failure (10 to 99 percent), how often it looks (5 to 600 seconds), and whether it pauses the printer itself. Where camera frames are sent is not changed here.",
      scope: "workspace",
      invokeHandler: "digifab.set-failure-detection",
      userInvokable: true,
      argsSchema: {
        enabled: { label: "On (true) or off (false)", type: "boolean" },
        threshold: { label: "How sure before it calls a failure, in percent", type: "number" },
        sample_interval_sec: { label: "How often it looks, in seconds", type: "number" },
        auto_pause: { label: "Pause the printer itself on a failure", type: "boolean" },
      },
    },
    {
      part: "printers",
      group: "make",
      // UI-SCREEN: /digifab
      id: "digifab:check-for-failure",
      changes: "records",
      runBy: "member",
      examples: ["is the print on the Mk4 failing", "check the Bambu for spaghetti"],
      label: "Check a print for failure",
      description:
        "Look at a printer's camera once now and say how likely its print is failing, without pausing anything or changing the watch. Takes the printer's connection and device as read_fabrication_floor lists them.",
      scope: "workspace",
      invokeHandler: "digifab.check-for-failure",
      userInvokable: true,
      argsSchema: {
        connection_id: { label: "Connection", type: "text", required: true },
        device_id: { label: "Device", type: "text", required: true },
      },
    },
    {
      part: "printers",
      group: "make",
      // UI-SCREEN: /digifab
      id: "digifab:test-detector",
      changes: "records",
      // ADMIN-ONLY: the page's own route POST /failure/detectors/:id/test is owner or admin (failure.ts)
      runBy: "admin",
      examples: ["is PrintGuard reachable"],
      label: "Test a failure detector",
      description: "Check that an outside failure detector (Obico, PrintGuard) answers at its address, and say what it said. Its key is never shown.",
      scope: "workspace",
      invokeHandler: "digifab.test-detector",
      userInvokable: true,
      argsSchema: {
        detector: { label: "Which detector (its name; empty: the only one)", type: "text" },
      },
    },
    {
      part: "printers",
      // Which printer should print this: ranked by fits, then loaded with
      // enough of the filament, then idle, then pool order (pick-printer.ts).
      // Sends nothing; the step before the one confirm card in "Print this".
      // UI-SCREEN: /files/:id, where Print this shows the printer it picked.
      group: "more",
      id: "digifab:pick-printer",
      changes: "records",
      runBy: "member",
      label: "Pick a printer for a print",
      description:
        "Ranks the linked printers for a print: the part has to fit the build volume, then a printer already loaded with enough of the material and colour, then an idle one, then the pool order. Returns each printer with the loaded spool and slot, its Printing profile (printer model, nozzle, quality, preset hint) and the reason. Sends nothing.",
      scope: "workspace",
      userInvokable: false,
      undoable: true,
      examples: ["which printer should print a 60 by 60 by 20 mm part in black PETG, about 40 grams?"],
      invokeHandler: "digifab.pick-printer",
      argsSchema: {
        material: { label: "Material", type: "text", required: true },
        color: { label: "Colour", type: "text" },
        grams: { label: "Grams of filament", type: "number", required: true },
        bbox_mm: { label: "Part size x, y, z (mm)", type: "list", required: true },
        nozzle_mm: { label: "Nozzle (mm)", type: "number" },
      },
    },
    {
      part: "printers",
      // UI-SCREEN: /makes/:id, the approved batch card.
      userInvokable: false,
      group: "more",
      id: "digifab:start-next-print", changes: "records", label: "Bed is clear, start the next one", effect: "physical",
      // ADMIN-ONLY: starts a physical printer; its page route POST /makes/:id/print/next gates on this action: the admin tier, or an operator (#6672)
      runBy: "admin",
      grantedAs: "digifab:operate",
      scope: "workspace", appliesTo: { kinds: ["digifab:make"] }, invokeHandler: "digifab.start-next-print",
      description: "Starts the next print in an approved Make batch after the person clears the bed. Always asks for a physical confirmation. Changed printer, files, spools, material or quantity require full batch review and approval again.",
      argsSchema: { make_id: { label: "Make", type: "text" } },
    },
    {
      part: "printers",
      // UI-SCREEN: /makes/:id, the batch review controls.
      userInvokable: false,
      group: "more",
      id: "digifab:review-print-batch", changes: "records", label: "Review the changed print batch", effect: "writes",
      // ADMIN-ONLY: re-approves what a batch will print; its page route POST /makes/:id/print/review gates on this action, owner or admin (makes.ts)
      runBy: "admin",
      scope: "workspace", appliesTo: { kinds: ["digifab:make"] }, invokeHandler: "digifab.review-print-batch",
      description: "Refreshes a waiting batch card with its current printer, file, spools and quantity. Starts no machine. A person must approve the new card before starting.",
      argsSchema: { make_id: { label: "Make", type: "text" }, quantity: { label: "Total prints including those finished", type: "number" } },
    },
    {
      part: "printers",
      // UI-SCREEN: /makes/:id, the remaining prints control.
      userInvokable: false,
      group: "more",
      id: "digifab:cancel-print-batch", changes: "records", label: "Cancel the remaining prints", effect: "stops",
      runBy: "member",
      scope: "workspace", appliesTo: { kinds: ["digifab:make"] }, invokeHandler: "digifab.cancel-print-batch",
      description: "Cancels a Make batch's remaining jobs immediately. Never starts a machine. An active job finishes.",
      argsSchema: { make_id: { label: "Make", type: "text" } },
    },
    {
      part: "printers",
      // Print this (Services §14.3): a model file (or a Make with one) to a
      // print. Opens a Make, picks the printer by pick-printer's rule,
      // slices for that printer's Printing profile, and leaves the print
      // waiting for a person's one yes on the Make. Starts no machine.
      // UI-SCREEN: /files/:id, the Print this panel on a model file's page.
      group: "more",
      id: "digifab:print-this",
      changes: "records",
      runBy: "member",
      label: "Print this",
      description:
        "Starts from a file, a Make, or a request with a design template or CAD source. For a design, prefer a template; otherwise write a SolidCraft command script (JSON with a list of commands, each a command and its params, as the design service describes it) or OpenSCAD source and pass it with the prompt. Design outputs wait for model approval on the Make. Then choose Print this to pick a printer and slice. Only Start the print moves a machine.",
      scope: "workspace",
      userInvokable: false,
      undoable: true,
      examples: ["print the bracket.stl in black PETG", "print this model in PLA"],
      invokeHandler: "digifab.print-this",
      argsSchema: {
        file_id: { label: "Model file", type: "text" },
        make_id: { label: "Make", type: "text" },
        prompt: { label: "What to make", type: "text" },
        source: { label: "CAD source: a SolidCraft command script (JSON) or OpenSCAD", type: "text" },
        source_lang: { label: "CAD language", type: "text", choices: [{ value: "solidcraft", label: "SolidCraft" }, { value: "openscad", label: "OpenSCAD" }] },
        template: { label: "Design template", type: "text" },
        params: { label: "Template parameters", type: "json" },
        quantity: { label: "Prints", type: "number" },
        material: { label: "Material", type: "text", required: true },
        color: { label: "Colour", type: "text" },
        bbox_mm: { label: "Part size x, y, z (mm)", type: "list" },
      },
    },
  ],
};
