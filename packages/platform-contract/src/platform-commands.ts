// Commands the KERNEL ships: sentences people say that one of the platform's
// own actions does, in one shape, with no AI connected at all.
//
// They ride the same `entity_commands` table as a module's `exposes.commands`
// (registry-sync compiles them under PLATFORM_OWNER beside the kernel's
// actions), and every workspace is offered them, whatever it has enabled,
// because the actions they run are the workspace's own fields. They live in
// the contract rather than beside the kernel's actions because the corpus
// test binds sentences against them with no api running.
//
// Why these two exist. Asked of a model, "add Aran to the yarn weight choices"
// rolled between running platform:edit-field and pointing at Configuration,
// two in three either way, and neither answer was wrong enough to fail on
// (#3159). Nothing about the sentence is ambiguous to a person: it names a
// choice and a field. A phrase command makes the action the literal thing
// that was said, deterministic and testable without a model, the way
// core-locations numbers a run of shelves. The field is named as it appears
// on the form; the handler resolves which kind carries it when one does and
// asks which when several do, so a command never guesses either.

import type { ModuleCommandDecl } from "./index.js";

/** The reserved owner of the kernel's own actions and commands in the
 *  registry (`platform:add-field`, `platform:add-a-choice`). A module may not
 *  take this name (lint-manifests refuses it), and a workspace is offered the
 *  platform's commands whatever modules it has enabled. A leaf module, so a
 *  script can import it without the whole contract. */
export const PLATFORM_OWNER = "platform";

/** Bumped when a command's sentence or plan changes. */
export const PLATFORM_COMMANDS_VERSION = "0.1.0";

export const PLATFORM_COMMANDS: ModuleCommandDecl[] = [
  {
    id: "platform:add-a-choice",
    template: "add {choice} to the {field} choices",
    description: "Add {choice} to the {field} choices",
    plan: [{ tool: "action", entityKind: "", actionId: "platform:edit-field", payload: { field: "{field}", add_choices: "{choice}" } }],
  },
  {
    id: "platform:remove-a-choice",
    template: "remove {choice} from the {field} choices",
    description: "Remove {choice} from the {field} choices",
    plan: [{ tool: "action", entityKind: "", actionId: "platform:edit-field", payload: { field: "{field}", remove_choices: "{choice}" } }],
  },
];
