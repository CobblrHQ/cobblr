// /calendar — the workspace calendar. A month grid of every dated thing
// across modules (scheduled maintenance, task due dates, food expiry),
// aggregated by the platform calendar registry. Plus a subscribe bar that
// hands out the tokenised iCal URL (works in Apple Calendar, and in Google
// Calendar via "add from URL").

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, CalendarDays, Link2, RefreshCw, Copy } from "lucide-react";
import { api, type CalendarEvent } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { usePageTitle, useToast } from "@cobblr/platform-web";
import { WEEKDAYS, MONTHS, isoLocal as iso, buildMonthGrid, shiftMonth } from "../lib/month-grid";

// Coarse colour per source/category.
const CAT_STYLE: Record<string, string> = {
  maintenance: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  task: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200",
  expiry: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200",
  date: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-200",
  order: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  _default: "bg-cobble-100 text-accent dark:bg-cobble-900/40 dark:text-cobble-200",
};
const catStyle = (c?: string) => CAT_STYLE[c ?? "_default"] ?? CAT_STYLE._default;

export function CalendarPage() {
  usePageTitle("Calendar");
  const { activeSlug: slug } = useActiveOrg();
  const navigate = useNavigate();
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
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
      const key = ev.date.slice(0, 10);
      (m[key] ||= []).push(ev);
    }
    return m;
  }, [events.data]);

  const todayKey = iso(new Date());

  function openEvent(ev: CalendarEvent) {
    if (ev.entityModule === "inventory" && ev.entityType === "part" && ev.entityId) {
      navigate(`/inventory/parts/${ev.entityId}`);
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
          <button onClick={() => setCursor((c) => shiftMonth(c, -1))} className="p-1.5 rounded hover:bg-cobble-100 dark:hover:bg-slate-800 transition" title="Previous month">
            <ChevronLeft size={16} />
          </button>
          <span className="text-sm font-medium text-content dark:text-mortar-100 min-w-[9rem] text-center">
            {MONTHS[cursor.m]} {cursor.y}
          </span>
          <button onClick={() => setCursor((c) => shiftMonth(c, 1))} className="p-1.5 rounded hover:bg-cobble-100 dark:hover:bg-slate-800 transition" title="Next month">
            <ChevronRight size={16} />
          </button>
          <button onClick={() => { const d = new Date(); setCursor({ y: d.getFullYear(), m: d.getMonth() }); }} className="ml-1 text-[10px] font-mono uppercase tracking-widest text-accent hover:underline">
            today
          </button>
        </div>
        <div className="flex-1" />
        <span className="text-[10px] font-mono text-faint dark:text-slate-500">{events.data?.items.length ?? 0} events</span>
      </div>

      {/* month grid */}
      <div className="rounded-xl border border-line dark:border-slate-700 overflow-hidden">
        <div className="grid grid-cols-7 bg-surface dark:bg-slate-900 border-b border-line dark:border-slate-700">
          {WEEKDAYS.map((w) => (
            <div key={w} className="px-2 py-1.5 text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 text-center">{w}</div>
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
                  (inMonth ? "bg-white dark:bg-slate-950" : "bg-mortar-50/40 dark:bg-slate-900/40")
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
                      title={ev.title}
                      className={"block w-full text-left truncate rounded px-1 py-0.5 text-[10px] leading-tight " + catStyle(ev.category)}
                    >
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

      <Legend />
      <SubscribeBar slug={slug} />
    </div>
  );
}

function Legend() {
  const items: [string, string][] = [["maintenance", "Maintenance due"], ["task", "Task due"], ["expiry", "Expiring"], ["order", "Order arriving"], ["date", "Renewal / due date"]];
  return (
    <div className="flex flex-wrap gap-3 text-[10px] font-mono text-faint dark:text-slate-500">
      {items.map(([cat, label]) => (
        <span key={cat} className="inline-flex items-center gap-1.5">
          <span className={"inline-block w-2.5 h-2.5 rounded-sm " + catStyle(cat)} /> {label}
        </span>
      ))}
    </div>
  );
}

function SubscribeBar({ slug }: { slug: string }) {
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
          disabled={toggle.isPending}
          className={"rounded-md text-sm font-medium px-3 py-1.5 transition " + (enabled ? "bg-cobble-100 text-accent dark:bg-cobble-900/40" : "bg-slate-700 hover:bg-slate-600 text-mortar-50")}
        >
          {enabled ? "Feed on" : "Enable feed"}
        </button>
        {enabled && url && (
          <>
            <input readOnly value={url} className="input flex-1 font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
            <button onClick={() => { void navigator.clipboard?.writeText(url); toast.success("Copied."); }} className="p-2 rounded hover:bg-cobble-100 dark:hover:bg-slate-800 transition" title="Copy URL">
              <Copy size={14} />
            </button>
            <button onClick={() => rotate.mutate()} disabled={rotate.isPending} className="p-2 rounded hover:bg-cobble-100 dark:hover:bg-slate-800 transition" title="Rotate (invalidate old URL)">
              <RefreshCw size={14} />
            </button>
          </>
        )}
      </div>
    </section>
  );
}

// ── grid math ─────────────────────────────────────────────────────────

