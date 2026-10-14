// The record stream's one event name, written by the api and listened for by
// the web. Both import it, so the two can never drift apart.
export const RECORD_STREAM_EVENT = "records";

/** A record in this workspace was written: by MCP, another device, an
 *  automation or another person. An open page showing it reads it again. */
export interface RecordStreamChange {
  /** `<module>:<entity type>`, as the activity log names it. */
  kind: string;
  id: string;
}
