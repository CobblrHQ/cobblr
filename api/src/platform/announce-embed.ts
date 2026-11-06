// The embed every announcement sends, new or edited, kept inside what Discord
// accepts. Discord refuses the whole message when one part is over: a long page
// address cost a report its card, and the team heard only by the fallback email.

import type { AnnouncePayload } from "./announce.js";

const TITLE = 256;
const DESCRIPTION = 4000;
const FIELDS = 10;
const FIELD_NAME = 256;
const FIELD_VALUE = 1024;
const WHOLE_EMBED = 6000;

/** At most `most` characters, never ending on half of an emoji. */
function cut(text: string, most: number): string {
  const kept = text.slice(0, most);
  return /[\uD800-\uDBFF]$/.test(kept) ? kept.slice(0, -1) : kept;
}

export function announceEmbed(payload: AnnouncePayload) {
  const title = cut(payload.title, TITLE);
  const description = payload.body ? cut(payload.body, DESCRIPTION) : undefined;
  let room = WHOLE_EMBED - title.length - (description?.length ?? 0);
  const fields: NonNullable<AnnouncePayload["fields"]> = [];
  for (const field of payload.fields ?? []) {
    if (fields.length === FIELDS || !field.value.trim()) continue;
    const name = cut(field.name, FIELD_NAME);
    const value = cut(field.value, Math.max(0, Math.min(FIELD_VALUE, room - name.length)));
    if (!value.trim()) break;
    fields.push({ ...field, name, value });
    room -= name.length + value.length;
  }
  return { title, description, color: payload.color, fields: payload.fields ? fields : undefined };
}
