// core-discussion — a conversation on any record.
//
// A CAPABILITY, not a domain: it adds no noun you manage, nobody opts in per
// kind, and every kind gets it. So `core-` and auto-on, per the naming test in
// docs/architecture/module-layers.md.
//
// The data model is the fourth polymorphic side-car, after tags, files and
// links — same (source_module, source_type, source_id) shape, so a module
// written next year gets discussion the way it already gets tags. If comments
// ever need a per-kind opt-in, the design has gone wrong.
//
// Spec: docs/design-decisions/discussion-and-the-side-rail.md

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-discussion",
  version: "0.7.2",
  maturity: "beta",
  displayName: "Discussion",
  description:
    "Talk about a record with the people you share a workspace with. One conversation per record, flat and chronological, reachable from the record itself.",
  icon: "message-square",
  band: "stock",
  // Ambient: a record you can't discuss is a record with a missing affordance,
  // and there is nothing for a user to decide by turning this on.
  autoEnable: true,

  // Browse-not-configure: the inbox is a page you VISIT, so it earns a route
  // and a nav entry even though this is a capability. Same exception core-tags
  // takes, for the same reason — "what is new for me" is not something you can
  // answer from a record you have not thought to open.
  nav: {
    label: "Discussion",
    route: "/discussion",
    icon: "message-square",
  },

  schema: {
    tablePrefix: "core_discussion_",
    migrationsDir: "./migrations",
  },

  api: () => import("./api/index.js"),

  dependencies: [],

  exposes: {
    events: [
      "core-discussion.comment.posted",
      "core-discussion.conversation.resolved",
    ],
    api: [],
    actions: [
      {
        id: "core-discussion:post-comment",
        examples: ["leave a note on this", "tell the others it needs a new nozzle"],
        label: "Comment",
        description:
          "Add a comment to this record's conversation, visible to everyone in the workspace. Pass `body` (markdown). Optionally `in_reply_to`, the id of a comment this one answers.",
        icon: "message-square",
        // DELIBERATELY universal: discussion is a polymorphic side-car like
        // tags and files, so "which kinds can be talked about" is every kind
        // there is. Scoping this by trait or kind would be inventing a rule the
        // data model does not have — and the first module it left out would be
        // the one someone wanted to discuss.
        appliesTo: { any: true },
        invokeHandler: "core-discussion.post-comment",
        // NOT undoable, deliberately. Deleting a comment leaves a tombstone,
        // and by then somebody may have read it — "put it back without help"
        // is not something an author can do about a sentence other people have
        // already seen. So a connection that cannot show a confirmation refuses
        // this one, which is the right way round for a shared conversation.
        undoable: false,
        argsSchema: {
          body: { label: "What to say", type: "text" },
          in_reply_to: { label: "Id of the comment this answers (optional)", type: "text" },
        },
        // The person-facing surface is the Discussion tab on the record, not a
        // button on every detail page: a record's conversation is something you
        // read and write in place, not fire as an action.
        userInvokable: false,
      },
      {
        id: "core-discussion:resolve-conversation",
        examples: ["mark this settled", "we've decided, close the discussion"],
        label: "Resolve the discussion",
        description:
          "Mark this record's conversation as settled. It collapses to a one-line count and stays searchable; posting into it opens it again. Nothing is deleted.",
        icon: "check",
        // DELIBERATELY universal: same reason as post-comment. Anything that
        // can hold a conversation can have that conversation settled.
        appliesTo: { any: true },
        invokeHandler: "core-discussion.resolve-conversation",
        undoable: true,
        argsSchema: {
          resolved: { label: "true to resolve, false to reopen", type: "boolean" },
        },
        userInvokable: false,
      },
    ],
  },

  // A conversation belongs to the RECORD, so it belongs on the record's detail
  // view — every one of them, not the handful of pages that happen to live in
  // the web app rather than inside a module.
  //
  // This is why: `EntityAttachments` (tags / discussion / files / links) is a
  // web-app component, and a module's own detail page cannot import it without
  // breaking isolation. So for the first weeks of this feature, inventory
  // parts — the most-used record type in the product — had no way to reach
  // discussion AT ALL, while locations and assets did. The compact pill form
  // had even been written for exactly that case and was never mounted.
  //
  // The panel seam already solved this shape for cross-module UI (purchases
  // puts price history on a part without inventory naming purchases), so a
  // conversation rides the same rail, targeting every kind.
  contributes: {
    panels: [
      {
        id: "core-discussion:conversation",
        surface: "entity-detail-panel" as const,
        target: "*",
        title: "Discussion",
      },
    ],
  },

  subscribes: [],
});
