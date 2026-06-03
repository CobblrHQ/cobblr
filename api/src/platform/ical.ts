// Minimal, spec-compliant iCalendar (RFC 5545) serializer for the calendar
// feed. Just what the feed needs: a VCALENDAR of all-day / timed VEVENTs
// with proper TEXT escaping and 75-octet line folding (the two things
// hand-rolled .ics output usually gets wrong, breaking strict parsers like
// Google Calendar).

import type { CalendarEvent } from "@cobblr/platform-contract";

/** Escape a TEXT value per RFC 5545 §3.3.11: backslash, semicolon, comma,
 *  and newlines. */
function esc(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** Fold a content line to ≤75 octets, continuation lines prefixed with a
 *  space, CRLF separators (RFC 5545 §3.1). Folds on character count — fine
 *  for our ASCII-leaning content. */
function fold(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [];
  let i = 0;
  parts.push(line.slice(0, 75));
  i = 75;
  while (i < line.length) {
    parts.push(" " + line.slice(i, i + 74));
    i += 74;
  }
  return parts.join("\r\n");
}

function toUtcStamp(d: Date): string {
  // YYYYMMDDTHHMMSSZ
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function isDateOnly(date: string, allDay?: boolean): boolean {
  return allDay === true || /^\d{4}-\d{2}-\d{2}$/.test(date.trim());
}

interface BuildOpts {
  name?: string;
  /** Override "now" for DTSTAMP — tests pass a fixed value for determinism. */
  nowMs?: number;
}

export function buildICS(events: CalendarEvent[], opts: BuildOpts = {}): string {
  const name = opts.name ?? "Cobblr";
  const dtstamp = toUtcStamp(opts.nowMs != null ? new Date(opts.nowMs) : new Date());
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Cobblr//Workspace Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(name)}`,
  ];

  for (const ev of events) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${esc(ev.id)}@cobblr`);
    lines.push(`DTSTAMP:${dtstamp}`);
    if (isDateOnly(ev.date, ev.allDay)) {
      const ymd = ev.date.slice(0, 10).replace(/-/g, "");
      lines.push(`DTSTART;VALUE=DATE:${ymd}`);
    } else {
      lines.push(`DTSTART:${toUtcStamp(new Date(ev.date))}`);
    }
    lines.push(`SUMMARY:${esc(ev.title)}`);
    if (ev.category) lines.push(`CATEGORIES:${esc(ev.category.toUpperCase())}`);
    if (ev.detailUrl) lines.push(`URL:${esc(ev.detailUrl)}`);
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
