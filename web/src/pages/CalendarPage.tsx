// /calendar — the workspace calendar. A month grid of every dated thing
// across modules (scheduled maintenance, task due dates, food expiry),
// aggregated by the platform calendar registry. Plus a subscribe bar that
// hands out the tokenised iCal URL (works in Apple Calendar, and in Google
// Calendar via "add from URL").

import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, CalendarDays, Link2, RefreshCw, Copy, MapPin } from "lucide-react";
import { api, type CalendarEvent } from "../lib/api";
import { CALENDAR_FEED_MANAGERS } from "@cobblr/platform-contract/org-roles";
import { useRoleAtLeast } from "../lib/can";
import { usePersistedState } from "../lib/use-persisted-state";
import { useAuth } from "../auth/AuthContext";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { AddressView, usePageTitle, useToast } from "@cobblr/platform-web";
import { WEEKDAYS, MONTHS, isoLocal as iso, buildMonthGrid, shiftMonth } from "../lib/month-grid";
import { openRecordPath } from "@cobblr/platform-contract/instance-detail";
import { dayLabel } from "@cobblr/platform-contract/day";

// Coarse colour per source/category.
const CAT_STYLE: Record<string, string> = {
  maintenance: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  task: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200",
  expiry: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200",
  date: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200",
  warranty: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  purchase: "bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200",
  order: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  _default: "bg-cobble-100 text-accent dark:bg-cobble-900/40 dark:text-cobble-200",
};
const catStyle = (c?: string) => CAT_STYLE[c ?? "_default"] ?? CAT_STYLE._default;

export function CalendarPage() {
  usePageTitle("Calendar");
  const { activeSlug: slug } = useActiveOrg();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [hiddenSources, setHiddenSources] = usePersistedState<string[]>(`calendar.sources.${user?.id}.${slug}`, []);
  // `?date=YYYY-MM-DD` opens the month that date is in and rings the day.
  // A notification about something dated ("three things expire on the 9th")
  // has to be able to land you ON it; without this the only destination the
  // calendar could offer was "this month, whatever month you happen to read
  // the message in".
  const [params] = useSearchParams();
  const focusKey = /^\d{4}-\d{2}-\d{2}$/.test(params.get("date") ?? "")
    ? params.get("date")!
    : null;
  const [cursor, setCursor] = useState(() => {
    const d = focusKey ? new Date(`${focusKey}T12:00:00`) : new Date();
    return { y: d.getFullYear(), m: d.getMonth() };
  });

  // The 6-week grid can spill into adjacent months — fetch a padded window.
  const { gridStart, gridEnd, weeks } = useMemo(() => buildMonthGrid(cursor.y, cursor.m), [cursor]);

  const events = useQuery({
    queryKey: ["calendar-events", slug, iso(gridStart), iso(gridEnd)],
    queryFn: () => api.calendarEvents(slug, iso(gridStart), iso(gridEnd)),
    enabled: !!slug,
  });

  const byDay = useMemo(() => {
    const m: Record<string, CalendarEvent[]> = {};
    for (const ev of events.data?.items ?? []) {
      if (hiddenSources.includes(ev.source)) continue;
      const key = ev.date.slice(0, 10);
      (m[key] ||= []).push(ev);
    }
    return m;
  }, [events.data, hiddenSources]);

  const todayKey = iso(new Date());

  function openEvent(ev: CalendarEvent) {
    if (ev.entityModule && ev.entityType && ev.entityId) {
      navigate(openRecordPath(`${ev.entityModule}:${ev.entityType}`, ev.entityId));
    } else if (ev.source === "maintenance") {
      navigate("/configuration/maintenance");
    } else if (ev.source === "task") {
      navigate("/projects");
    }
  }

  return (
    <div className="space-y-4 max-w-5xl mx-auto">
      <div className="flex flex-wrap items-center gap-3 border-b border-line dark:border-slate-700 pb-3">
        <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 page-title flex items-center gap-2">
          <CalendarDays size={22} className="text-accent" /> Calendar
        </h1>
        <div className="flex items-center gap-1">
          <button aria-label="Previous month" onClick={() => setCursor((c) => shiftMonth(c, -1))} className="p-1.5 rounded hover:bg-cobble-100 dark:hover:bg-slate-800 transition" title="Previous month">
            <ChevronLeft size={16} />
          </button>
          <span className="text-sm font-medium text-content dark:text-mortar-100 min-w-[9rem] text-center">
            {MONTHS[cursor.m]} {cursor.y}
          </span>
          <button aria-label="Next month" onClick={() => setCursor((c) => shiftMonth(c, 1))} className="p-1.5 rounded hover:bg-cobble-100 dark:hover:bg-slate-800 transition" title="Next month">
            <ChevronRight size={16} />
          </button>
          <button onClick={() => { const d = new Date(); setCursor({ y: d.getFullYear(), m: d.getMonth() }); }} className="ml-1 text-[10px] uppercase tracking-widest text-accent hover:underline">
            today
          </button>
        </div>
        <div className="flex-1" />
        <span className="text-[10px] font-mono text-faint dark:text-slate-500">{Object.values(byDay).reduce((n, list) => n + list.length, 0)} events</span>
      </div>

      <SourceFilters events={events.data?.items ?? []} hidden={hiddenSources} onChange={setHiddenSources} />

      {/* month grid */}
      <div className="rounded-xl border border-line dark:border-slate-700 overflow-hidden">
        <div className="grid grid-cols-7 bg-surface dark:bg-slate-900 border-b border-line dark:border-slate-700">
          {WEEKDAYS.map((w) => (
            <div key={w} className="px-2 py-1.5 text-[10px] uppercase tracking-widest text-faint dark:text-slate-500 text-center">{w}</div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {weeks.flat().map((day) => {
            const key = iso(day);
            const inMonth = day.getMonth() === cursor.m;
            const dayEvents = byDay[key] ?? [];
            return (
              <div
                key={key}
                className={
                  "min-h-[5.5rem] border-b border-r border-line dark:border-slate-800 p-1 " +
                  (inMonth ? "bg-white dark:bg-slate-950" : "bg-mortar-50/40 dark:bg-slate-900/40") +
                  (key === focusKey ? " ring-2 ring-inset ring-accent" : "")
                }
              >
                <div className={"text-[11px] font-mono mb-1 px-1 " + (key === todayKey ? "inline-flex items-center justify-center w-5 h-5 rounded-full bg-accent text-white" : inMonth ? "text-content dark:text-mortar-200" : "text-faint dark:text-slate-600")}>
                  {day.getDate()}
                </div>
                <div className="space-y-0.5">
                  {dayEvents.slice(0, 4).map((ev) => (
                    <button
                      key={ev.id}
                      onClick={() => openEvent(ev)}
                      title={ev.location ? `${ev.title}\nWhere: ${ev.location}` : ev.title}
                      className={"block w-full text-left truncate rounded px-1 py-0.5 text-[10px] leading-tight " + catStyle(ev.category)}
                    >
                      {ev.location && <MapPin size={9} className="mr-0.5 inline-block align-[-1px]" aria-label="Has an address" />}
                      {ev.title}
                    </button>
                  ))}
                  {dayEvents.length > 4 && (
                    <div className="text-[9px] text-faint dark:text-slate-500 px-1">+{dayEvents.length - 4} more</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <WhereToBe events={(events.data?.items ?? []).filter((ev) => !hiddenSources.includes(ev.source) && ev.date.slice(0, 7) === `${cursor.y}-${String(cursor.m + 1).padStart(2, "0")}`)} onOpen={openEvent} />

      <WarrantyReminders slug={slug} />
      <SubscribeBar slug={slug} />
    </div>
  );
}

/** The month's events that happen somewhere: when, what, and where, with
 *  directions. A day square has no room for an address; this list does. */
function WhereToBe({ events, onOpen }: { events: CalendarEvent[]; onOpen: (ev: CalendarEvent) => void }) {
  const placed = events.filter((ev) => ev.location);
  if (placed.length === 0) return null;
  return (
    <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-3" data-testid="calendar-where">
      <h2 className="text-[10px] uppercase tracking-widest text-faint dark:text-slate-500 mb-2">Where to be this month</h2>
      <ul className="divide-y divide-line dark:divide-slate-700">
        {placed.map((ev) => (
          <li key={ev.id} className="flex flex-col gap-0.5 py-2 sm:flex-row sm:items-baseline sm:gap-3" data-testid="calendar-where-row">
            <span className="shrink-0 font-mono text-xs text-muted dark:text-slate-400 sm:w-24">{dayLabel(ev.date, { weekday: "short", month: "short", day: "numeric" })}</span>
            <button type="button" onClick={() => onOpen(ev)} className="min-w-0 truncate text-left text-sm font-medium text-content dark:text-mortar-100 hover:text-accent sm:w-56">{ev.title}</button>
            <span className="min-w-0 flex-1 text-sm"><span className="text-faint">Where: </span><AddressView value={{ line: ev.location, source: "used", ...ev.geo }} inline /></span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SourceFilters({ events, hidden, onChange }: { events: CalendarEvent[]; hidden: string[]; onChange: (sources: string[]) => void }) {
  const sources = new Map<string, string>([
    ["maintenance", "Maintenance due"], ["task", "Task due"], ["expiry", "Expiring"],
    ["order", "Order arriving"], ["warranty", "Warranty ends"], ["purchase", "Purchased"],
  ]);
  for (const event of events) if (!sources.has(event.source)) sources.set(event.source, event.sourceLabel ?? "Other dates");
  return (
    <fieldset className="flex flex-wrap gap-3 text-xs text-content">
      <legend className="mb-2 font-medium">Show on calendar</legend>
      {[...sources].map(([source, label]) => (
        <label key={source} className="inline-flex items-center gap-1.5">
          <input type="checkbox" checked={!hidden.includes(source)}
            onChange={(e) => onChange(e.target.checked ? hidden.filter((s) => s !== source) : [...hidden, source])} />
          {label}
        </label>
      ))}
    </fieldset>
  );
}

function WarrantyReminders({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const settings = useQuery({ queryKey: ["warranty-reminders", slug], queryFn: () => api.getWarrantyReminders(slug), enabled: !!slug });
  const save = useMutation({
    mutationFn: (enabled: boolean) => api.setWarrantyReminders(slug, enabled),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["warranty-reminders", slug] }); },
    onError: (e) => toast.error((e as Error).message),
  });
  // The reminders route reads the same list (api/src/routes/calendar.ts).
  const canEdit = useRoleAtLeast(CALENDAR_FEED_MANAGERS);
  return (
    <section className="rounded-xl border border-line bg-surface p-4 space-y-2">
      <label className="flex items-center gap-2 text-sm font-medium">
        <input type="checkbox" checked={settings.data?.enabled ?? false}
          disabled={!canEdit || !settings.data || save.isPending}
          onChange={(e) => save.mutate(e.target.checked)} />
        Remind us 30 days before a warranty ends
      </label>
      <p className="text-xs text-content">Reminders appear in notifications and join your daily digest. Choose when it arrives in your account’s Delivery settings.</p>
      {!canEdit && <p className="text-xs text-faint">An owner or admin can change this for the workspace.</p>}
    </section>
  );
}

function SubscribeBar({ slug }: { slug: string }) {
  const canManage = useRoleAtLeast(CALENDAR_FEED_MANAGERS);
  const qc = useQueryClient();
  const toast = useToast();
  const feed = useQuery({ queryKey: ["calendar-feed", slug], queryFn: () => api.getCalendarFeed(slug), enabled: !!slug });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.setCalendarFeed(slug, enabled),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["calendar-feed", slug] }); },
    onError: (e) => toast.error((e as Error).message),
  });
  const rotate = useMutation({
    mutationFn: () => api.rotateCalendarFeed(slug),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["calendar-feed", slug] }); toast.success("New feed URL - the old one stopped working."); },
    onError: (e) => toast.error((e as Error).message),
  });

  const enabled = feed.data?.enabled ?? false;
  const url = feed.data?.url ?? "";

  return (
    <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Link2 size={16} className="text-accent" />
        <span className="text-sm font-medium text-content dark:text-mortar-100">Subscribe from your phone or Google Calendar</span>
      </div>
      <p className="text-xs text-content dark:text-mortar-200">
        Turn on a private feed URL, then add it to Apple Calendar, Outlook, or Google Calendar (<span className="font-mono">Other calendars → From URL</span>). It stays in sync - no app, no account on the other end. The URL is a secret; rotate it to cut off old subscribers.
      </p>
      <div className="flex items-center gap-2">
        <button
          onClick={() => toggle.mutate(!enabled)}
          disabled={!canManage || toggle.isPending}
          className={"rounded-md text-sm font-medium px-3 py-1.5 transition " + (enabled ? "bg-cobble-100 text-accent dark:bg-cobble-900/40" : "bg-slate-700 hover:bg-slate-600 text-mortar-50")}
        >
          {enabled ? "Feed on" : "Enable feed"}
        </button>
        {enabled && url && (
          <>
            <input aria-label="Calendar feed link" readOnly value={url} className="input flex-1 font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
            <button aria-label="Copy URL" onClick={() => { void navigator.clipboard?.writeText(url); toast.success("Copied."); }} className="p-2 rounded hover:bg-cobble-100 dark:hover:bg-slate-800 transition" title="Copy URL">
              <Copy size={14} />
            </button>
            <button aria-label="Rotate (invalidate old URL)" onClick={() => rotate.mutate()} disabled={!canManage || rotate.isPending} className="p-2 rounded hover:bg-cobble-100 disabled:opacity-50 disabled:hover:bg-transparent dark:hover:bg-slate-800 transition" title="Rotate (invalidate old URL)">
              <RefreshCw size={14} />
            </button>
          </>
        )}
      </div>
      {!canManage && <p className="text-xs text-faint">An owner or admin can turn the feed on or off and change its link. {enabled ? "You can copy it." : ""}</p>}
    </section>
  );
}

// ── grid math ─────────────────────────────────────────────────────────

