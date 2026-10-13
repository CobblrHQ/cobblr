// #6197 candidate 2: send a chat request only the tools it can use, chosen by
// code from its words, never by a model. Measured, not shipped: the chat
// sends every tool until bench-action-rail.ts --tool-subset shows the same
// tool picked with the same arguments on the whole corpus. Tool definitions
// are about 6,000 to 8,000 of a turn's ~10,500 tokens.

interface ToolDef {
  name: string;
}

/** Reads that answer most questions about a workspace's records: always sent. */
const CORE = new Set([
  "take_user_to",
  "list_record_kinds",
  "list_records",
  "count_records",
  "get_record",
  "search_records",
  "list_related",
  "list_actions",
  "get_attention",
]);

/** A request that changes something says so: an imperative or a wish. */
const WRITES = /\b(add|create|make|new|put|move|rename|change|set|update|edit|delete|remove|discard|mark|file|log|record|track|start|stop|run|print|assign|link|undo|archive|restore|split|merge|combine|tag|increase|decrease|use up|used|bought|got|sold|lent|returned|order)\b/i;

const WRITE_TOOLS = new Set(["add_thing", "create_record", "create_records", "update_record", "delete_record", "invoke_action"]);

/** Tools a topic's words bring in, beyond the core and the writes. */
const TOPICS: Array<{ words: RegExp; tools: string[] }> = [
  { words: /\b(scan|scanned|inbox|captur|unfiled|put back|put away|putaway|station)/i, tools: ["list_scan_inbox", "get_scan_item", "file_inbox_items", "put_back_scan_item", "get_putaway_plan", "replan_putaway", "list_scan_stations", "list_scan_station_sessions", "get_scan_station_session"] },
  { words: /\b(who|whose|mine|my|owns?|owned|belong)/i, tools: ["things_of_person"] },
  { words: /\b(history|activity|changed|recent|lately|last time|yesterday|this week|did i|who did)/i, tools: ["list_activity"] },
  { words: /\b(notif|alert|remind|ping|tell me when)/i, tools: ["list_notifications", "get_my_notification_delivery"] },
  { words: /\b(suggest|tidy|clean ?up|ideas?)\b/i, tools: ["list_suggestions"] },
  { words: /\b(calendar|schedule|due|when|today|tomorrow|week|month|appointment|overdue)/i, tools: ["list_calendar", "list_maintenance"] },
  { words: /\b(maintenance|service|serviced|oil|filter|inspect|warranty|renew)/i, tools: ["list_maintenance"] },
  { words: /\b(address|ship|send to|deliver|post to)/i, tools: ["find_addresses"] },
  { words: /\b(setup|settings?|configur|fields?|views?|automation|wire|apps?|devices?|bridge|provider|bundle|module)/i, tools: ["get_workspace_setup"] },
  { words: /\b(kiln|fir(e|ing)|glaze)/i, tools: ["read_kiln"] },
  { words: /\b(laser|cut|engrave)/i, tools: ["read_laser_batch"] },
  { words: /\b(bench|instrument|meter|scope|measure)/i, tools: ["read_bench"] },
  { words: /\b(fabricat|floor|queue|printer|print|cnc|machine|job)/i, tools: ["read_fabrication_floor"] },
  { words: /\b(label|qr|code prefix|barcode prefix)/i, tools: ["list_label_codes"] },
  { words: /\b(service|paperless|connected|integration|import from)/i, tools: ["list_services", "invoke_service", "get_service_job"] },
];

/** The tools this request can use, in the order they were given. */
export function toolsForRequest<T extends ToolDef>(text: string, tools: readonly T[]): T[] {
  const keep = new Set(CORE);
  if (WRITES.test(text)) for (const t of WRITE_TOOLS) keep.add(t);
  for (const topic of TOPICS) if (topic.words.test(text)) for (const t of topic.tools) keep.add(t);
  return tools.filter((t) => keep.has(t.name));
}
