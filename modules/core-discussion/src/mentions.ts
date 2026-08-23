// The discussion module's use of the shared entity-token grammar.
//
// The grammar itself lives in @cobblr/platform-contract/entity-tokens, because
// the browser has to read exactly what the server wrote and a disagreement
// between two copies is silent in both directions. Only the part that is
// genuinely about DISCUSSION lives here.

export {
  parseMentions,
  entityMentions,
  mentionsAssistant,
  userMentions,
  splitMentions,
  type Mention,
} from "@cobblr/platform-contract/entity-tokens";

/** The relationship a mention writes.
 *
 *  Its OWN rel, deliberately: cleanup can then remove only links a mention
 *  made, and a link the user created by hand between the same two records
 *  survives untouched. Without a dedicated rel, reconciling a mention would
 *  quietly delete somebody's own work. */
export const MENTION_REL = "mentioned-in";
