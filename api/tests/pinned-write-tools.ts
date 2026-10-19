// The write tools an AI connection gets, pinned by name, ONCE. Two tests hold
// it (workspace-tools.test.ts: a clean read/write partition; platform-actions
// .test.ts: kernel config rides invoke_action, never a bespoke write tool),
// and when each kept its own copy one new tool cost two hand edits and a red
// run between them (#4474). Growing it is a decision: say why beside the name.
export const PINNED_WRITE_TOOLS = [
  // A thing a person owns, added through the scan inbox's intake (#4472):
  // a record write that runs the scan's checks first, not kernel config.
  "add_thing",
  "create_record",
  // The plural of a record tool, not a bespoke config one: same rail, same
  // kinds, many at a time (2026-08-20). It adds no new REACH: same kind, same
  // create route, same permission check as create_record, and every record it
  // makes gets its own ledger row and undo.
  "create_records",
  "delete_record",
  // Inbox items filed into a list through the inbox's own confirm: record
  // writes after the scan's checks, like add_thing, not kernel config.
  "file_inbox_items",
  // A scan inbox item put back as a step in its History found it (#6100):
  // the card's own Put back, through the chat ledger, undoable like a filing.
  "put_back_scan_item",
  // What a person does to inbox items from their cards (#6949): edit, discard,
  // restore, send back, rerun, combine, theme, photo. One module tool (sent only
  // where Scan is on), each step the card's own route as the asker.
  "change_scan_item",
  // The one write rail for every module operation, entity or workspace.
  "invoke_action",
  // The one door to outside services (#4034), not a kernel-config write: it
  // starts a job on a connected service, and whether it may run is the
  // service gate's to decide (service-consent.ts), never this tool's.
  "invoke_service",
  "update_record",
];
