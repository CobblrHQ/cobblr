// A comment as PLAIN TEXT, for somewhere that cannot render the real thing.
//
// The stored body carries entity tokens — `[[user:<uuid>]]` and friends — which
// the app turns into chips. Anywhere else they have to be rendered or they go
// out raw, and a uuid in a message somebody reads is not a cosmetic problem: it
// happened, in a Discord DM, and it read as broken software.
//
// So the tokens are always resolved to WORDS here, never dropped and never
// passed through. The only question is which words, and the honest answer
// depends on what the caller knows:
//
//   the reader themselves   →  "you"        (a DM knows who it is talking to)
//   anybody else            →  "someone"    (no name map exists at this layer,
//                                            and inventing one to look names up
//                                            would put a user-directory read
//                                            inside a notification path)
//   the assistant           →  "Cobb"
//   a record                →  "@record" (the token carries a kind and an id,
//                                and the name is looked up at draw time)
//
// "someone" is deliberately plain rather than a guess. A wrong name is worse
// than a vague one, and the message links back to the place the real chips are.

import { splitMentions } from "./mentions.js";

export function plainBody(body: string, opts: { youUserId?: string | null } = {}): string {
  const you = opts.youUserId ?? null;
  let out = "";
  for (const piece of splitMentions(body)) {
    if (piece.t === "text") out += piece.value;
    else if (piece.t === "cobb") out += "@Cobb";
    else if (piece.t === "user") out += piece.id === you ? "@you" : "@someone";
    // An entity token carries a kind and an id, not a label — the app looks the
    // name up when it draws the chip. There is nothing to look it up with here,
    // so it reads as what it is rather than as an id.
    else out += "@record";
  }
  // A LAST NET, deliberately after the parser rather than instead of it.
  //
  // splitMentions returns anything it does not recognise as literal TEXT — a
  // token spelled a way it has not learned, a truncated row, a form some later
  // version writes. So "the parser handles every kind" is not a guarantee this
  // can offer, and the guarantee that matters here is narrower and absolute:
  // nothing bracket-shaped reaches a reader. Found by a test using the wrong
  // spelling for the assistant token, which sailed through untouched.
  const swept = out.replace(/\[\[[^\]]*\]\]/g, "@mention");
  // Tokens sit inside the sentence, so removing one can leave doubled spaces.
  return swept.replace(/[ \t]{2,}/g, " ").trim();
}

/** The body, trimmed to fit somewhere with a size limit, without cutting a word
 *  in half or ending on a dangling ellipsis when nothing was cut. */
export function excerpt(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
