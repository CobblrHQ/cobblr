// Amazon Logistics (TBA… numbers), via Amazon's own public tracking page.
//
// The page at track.amazon.com reads its data from an unauthenticated JSON
// endpoint, /api/tracker/<number>: no key, no account, no card, which is the
// only way tracking stays free (no paid APIs). Many stores ship through Amazon
// Logistics without being Amazon (a Shopify store fulfilled by FBA), so this
// is the carrier for parcels whose only number is a TBA.
//
// It is a page's data, not a published API, so it is read politely: the
// cadence decides when (a few times a day, more on the delivery day), one
// answer is reused for a few minutes, and a refusal or a captcha is "cannot
// read it right now", never a state. After one, this driver stays quiet for
// an hour rather than asking again; the caller keeps the last state it had.

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  CarrierError,
  type CarrierDriver,
  type ShipmentEvent,
  type ShipmentState,
  type ShipmentStatus,
} from "../status.js";

const ENDPOINT = "https://track.amazon.com/api/tracker/";

/** Amazon's summary status to ours. A table: an unlisted status is one of
 *  the many flavours of "moving", which is what the fallback says. */
const SUMMARY_STATE: Record<string, ShipmentState> = {
  CreationConfirmed: "pre_transit",
  ReadyForReceive: "pre_transit",
  PickupDone: "in_transit",
  Received: "in_transit",
  InTransit: "in_transit",
  Departed: "in_transit",
  ArrivedAtCarrierFacility: "in_transit",
  OutForDelivery: "out_for_delivery",
  Delivered: "delivered",
  DeliveryAttempted: "exception",
  Undeliverable: "exception",
  Rejected: "exception",
  ReturnInitiated: "exception",
  ReturnToSeller: "exception",
  Lost: "exception",
  Damaged: "exception",
};

/** The milestone ids the progress bar uses, for when the summary says
 *  nothing we know. */
const MILESTONE_STATE: Record<string, ShipmentState> = {
  swa_rex_shipping_label_created: "pre_transit",
  swa_rex_intransit: "in_transit",
  swa_rex_ofd: "out_for_delivery",
  swa_rex_delivered: "delivered",
};

/** Words for the ids Amazon's page translates; anything else is the id
 *  itself, made readable. Shown, never branched on. */
const WORDS: Record<string, string> = {
  swa_rex_detail_creation_confirmed: "Label created, waiting for the package",
  swa_rex_shipping_label_created: "Label created",
  swa_rex_detail_pickedup: "Picked up",
  swa_rex_detail_arrived_at_facility: "Arrived at an Amazon facility",
  swa_rex_detail_departed: "Left an Amazon facility",
  swa_rex_intransit: "In transit",
  swa_rex_ofd: "Out for delivery",
  swa_rex_detail_out_for_delivery: "Out for delivery",
  swa_rex_delivered: "Delivered",
  swa_rex_detail_delivered: "Delivered",
  swa_rex_detail_delivery_attempted: "Delivery attempted",
};

function words(id: string | undefined): string {
  if (!id) return "";
  return WORDS[id] ?? id.replace(/^swa_rex_(?:detail_)?/, "").replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

const MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };

/** "Oct 11, 2026, 3:00:00 AM" as written, with no zone: the delivery day is
 *  the date it names, read without a clock that would move it a day. */
export function amazonDate(s: string | null | undefined): { date: string; at: string } | null {
  // Amazon writes a narrow no-break space before AM/PM, so any space will do.
  const m = /^([A-Za-z]{3})[a-z]*\.?\s(\d{1,2}),\s(\d{4})(?:,?\s(\d{1,2}):(\d{2})(?::(\d{2}))?\s?([AP]M))?/u.exec((s ?? "").trim());
  if (!m) return null;
  const month = MONTHS[m[1]!.toLowerCase()];
  if (!month) return null;
  const date = `${m[3]}-${month}-${m[2]!.padStart(2, "0")}`;
  let hour = Number(m[4] ?? 0);
  if (m[7] === "PM" && hour < 12) hour += 12;
  if (m[7] === "AM" && hour === 12) hour = 0;
  const at = `${date}T${String(hour).padStart(2, "0")}:${m[5] ?? "00"}:${m[6] ?? "00"}`;
  return { date, at };
}

interface Milestone {
  isActive?: boolean;
  eventSummary?: { statusElement?: { translatorString?: { localisedStringId?: string } }; timeElement?: string };
}
interface ProgressTracker {
  progressMeter?: { milestoneList?: Milestone[] };
  summary?: { status?: string; metadata?: { expectedDeliveryDate?: { date?: string }; promisedDeliveryDate?: { date?: string } } };
  expectedDeliveryDate?: string;
}
interface HistoryEvent {
  eventCode?: string;
  statusSummary?: { localisedStringId?: string };
  eventTime?: string;
  location?: { city?: string; stateProvince?: string; countryCode?: string };
}
export interface AmazonTrackerResponse {
  progressTracker?: string | null;
  eventHistory?: string | null;
}

function json<T>(s: string | null | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function place(loc: HistoryEvent["location"]): string | null {
  if (!loc) return null;
  const parts = [loc.city, loc.stateProvince].filter(Boolean);
  return parts.length ? parts.join(", ") : (loc.countryCode ?? null);
}

/** One tracker response to our vocabulary. Pure, so the mapping is tested
 *  against a recorded answer rather than against Amazon. */
export function parseAmazonTracker(number: string, body: AmazonTrackerResponse, checkedAt: string): ShipmentStatus {
  const progress = json<ProgressTracker>(body.progressTracker);
  const history = json<{ eventHistory?: HistoryEvent[] }>(body.eventHistory)?.eventHistory ?? [];
  if (!progress?.summary?.status && !(progress?.progressMeter?.milestoneList?.length)) {
    return {
      carrier: "amazon",
      number,
      state: "unknown",
      description: "Amazon has no information for this number yet",
      location: null,
      estimatedDelivery: null,
      deliveredAt: null,
      events: [],
      checkedAt,
    };
  }

  const summary = progress.summary?.status ?? "";
  const active = [...(progress.progressMeter?.milestoneList ?? [])].reverse().find((m) => m.isActive);
  const activeId = active?.eventSummary?.statusElement?.translatorString?.localisedStringId;
  const state: ShipmentState =
    SUMMARY_STATE[summary] ?? (activeId ? MILESTONE_STATE[activeId] : undefined) ?? (summary ? "in_transit" : "unknown");

  const events: ShipmentEvent[] = history
    .map((e) => ({ when: amazonDate(e.eventTime), e }))
    .filter((x): x is { when: { date: string; at: string }; e: HistoryEvent } => x.when !== null)
    .sort((a, b) => b.when.at.localeCompare(a.when.at))
    .map(({ when, e }) => ({ at: when.at, description: words(e.statusSummary?.localisedStringId) || e.eventCode || "", location: place(e.location) }));

  const delivered = history.find((e) => e.eventCode === "Delivered");
  const eta =
    amazonDate(progress.summary?.metadata?.expectedDeliveryDate?.date) ??
    amazonDate(progress.expectedDeliveryDate) ??
    amazonDate(progress.summary?.metadata?.promisedDeliveryDate?.date);

  return {
    carrier: "amazon",
    number,
    state,
    description: events[0]?.description || words(activeId) || summary,
    location: events[0]?.location ?? null,
    estimatedDelivery: eta?.date ?? null,
    deliveredAt: state === "delivered" ? (amazonDate(delivered?.eventTime)?.at ?? events[0]?.at ?? null) : null,
    events,
    checkedAt,
  };
}

/** One answer per number for a few minutes: a forced re-check right after a
 *  sweep (an email arriving, a person opening the order) reuses it. */
const REUSE_MS = 10 * 60_000;
/** After a refusal or a captcha, how long to leave Amazon alone. */
const QUIET_AFTER_REFUSAL_MS = 60 * 60_000;

const recent = new Map<string, ShipmentStatus & { at: number }>();
let quietUntil = 0;

/** For tests: forget the reuse cache and any quiet period. */
export function resetAmazonDriverForTests(): void {
  recent.clear();
  quietUntil = 0;
}

function refused(message: string): CarrierError {
  quietUntil = Date.now() + QUIET_AFTER_REFUSAL_MS;
  return new CarrierError(message, true, { busy: true, retryAfterMs: QUIET_AFTER_REFUSAL_MS });
}

export const amazonLogisticsDriver: CarrierDriver = {
  code: "amazon",

  // Public, keyless: there is nothing to set up.
  configured() {
    return true;
  },

  async track(number: string): Promise<ShipmentStatus> {
    const now = Date.now();
    // Only an Amazon Logistics label is Amazon's to answer for. An Amazon
    // ORDER number, or a number another carrier delivers, never reaches it.
    if (!/^TB[A-Z]\d{12}$/.test(number)) return parseAmazonTracker(number, {}, new Date(now).toISOString());
    if (now < quietUntil) {
      throw new CarrierError("Amazon's tracking page asked us to slow down; trying again later", true, { busy: true, retryAfterMs: quietUntil - now });
    }
    const hit = recent.get(number);
    if (hit && now - hit.at < REUSE_MS) {
      const { at: _at, ...status } = hit;
      return status;
    }

    // A RECORDED answer, never the network, where one is configured: CI and a
    // test rig follow TBA numbers from tracking-cassettes/amazon/<number>.json
    // (a number with no recording has no information yet).
    const replay = process.env.COBBLR_TRACKING_REPLAY_DIR || "";
    if (replay) {
      const recorded = await readFile(path.join(replay, "amazon", `${number}.json`), "utf8").catch(() => null);
      return parseAmazonTracker(number, recorded ? (JSON.parse(recorded) as AmazonTrackerResponse) : {}, new Date(now).toISOString());
    }

    const res = await fetch(`${ENDPOINT}${encodeURIComponent(number)}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 403 || res.status === 429 || res.status === 503) {
      throw refused(`Amazon's tracking page refused the read (HTTP ${res.status})`);
    }
    if (!res.ok) {
      throw new CarrierError(`Amazon's tracking page failed (HTTP ${res.status})`, res.status >= 500);
    }
    // A captcha arrives as a 200 with a web page in it.
    const type = res.headers.get("content-type") ?? "";
    const text = await res.text();
    let body: AmazonTrackerResponse;
    try {
      if (!type.includes("json")) throw new Error("not json");
      body = JSON.parse(text) as AmazonTrackerResponse;
    } catch {
      throw refused("Amazon's tracking page answered with a page, not tracking data (a captcha)");
    }

    const status = parseAmazonTracker(number, body, new Date(now).toISOString());
    recent.set(number, { ...status, at: now });
    return status;
  },
};
