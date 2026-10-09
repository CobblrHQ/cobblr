// "Check my mailbox" (#5462): run the order-email rules over a connected
// mailbox's whole history, filing nothing, and review what they decided.
//
//   POST /me/mail-sources/:id/checks               {after?, before?} start one
//   GET  /me/mail-sources/:id/checks/latest        progress, totals, delta
//   GET  /me/mail-sources/:id/checks/:check/stores per year and store
//   GET  /me/mail-sources/:id/checks/:check/items  ?list=misses|false-hits|ask-ai|orders|all
//   POST /me/mail-sources/:id/checks/:check/items/:gmail/verdict  {is_order}
//   GET  /me/mail-sources/:id/checks/:check/marked the marked ones, as fixtures
//   POST /me/mail-sources/:id/checks/:check/stop
//
// Every route is the mailbox owner's alone: a mailbox is personal.

import { Router } from "express";
import { z } from "zod";
import { meta } from "../db/meta.js";
import { requireAuth } from "../auth/middleware.js";
import { myMailSources } from "../platform/mail-source/store.js";
import { candidateQuery } from "../platform/mail-source/check-walk.js";
import { checkByYearAndStore, checkItems, checkSummary, markedForFixtures, recordVerdict, type ReviewList } from "../platform/mail-source/check-report.js";

export const mailboxCheckRouter = Router();

type Req = Parameters<Parameters<typeof mailboxCheckRouter.get>[1]>[0];

async function ownMailbox(req: Req): Promise<string | null> {
  const id = String(req.params.id ?? "");
  const mine = (await myMailSources(req.session!.id)).find((m) => m.id === id);
  return mine ? id : null;
}

async function ownCheck(req: Req): Promise<string | null> {
  const credentialId = await ownMailbox(req);
  if (!credentialId) return null;
  const c = await meta.selectFrom("mailbox_checks").select("id").where("id", "=", String(req.params.check ?? "")).where("credential_id", "=", credentialId).executeTakeFirst();
  return c?.id ?? null;
}

const notFound = (res: { status: (n: number) => { json: (b: unknown) => void } }) =>
  res.status(404).json({ error: { code: "not_found", message: "No such mailbox check." } });

const Start = z.object({
  after: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

// AI-REACH: exempt — it reads the person's own mailbox; an assistant never starts a read of somebody's mail.
// UI-SCREEN: /me/connections
mailboxCheckRouter.post("/me/mail-sources/:id/checks", requireAuth, async (req, res, next) => {
  try {
    const credentialId = await ownMailbox(req);
    if (!credentialId) return void notFound(res);
    const parsed = Start.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: { code: "bad_body", message: "after and before are dates (YYYY-MM-DD)." } });
      return;
    }
    // One running check per mailbox: a second press shows the one in progress.
    const running = await meta.selectFrom("mailbox_checks").select("id").where("credential_id", "=", credentialId).where("status", "=", "running").executeTakeFirst();
    if (running) {
      res.json(await checkSummary(running.id));
      return;
    }
    const made = await meta
      .insertInto("mailbox_checks")
      .values({ credential_id: credentialId, user_id: req.session!.id, query: candidateQuery(parsed.data) })
      .returning("id")
      .executeTakeFirstOrThrow();
    res.status(201).json(await checkSummary(made.id));
  } catch (err) {
    next(err);
  }
});

mailboxCheckRouter.get("/me/mail-sources/:id/checks/latest", requireAuth, async (req, res, next) => {
  try {
    const credentialId = await ownMailbox(req);
    if (!credentialId) return void notFound(res);
    const last = await meta.selectFrom("mailbox_checks").select("id").where("credential_id", "=", credentialId).orderBy("started_at", "desc").executeTakeFirst();
    res.json(last ? await checkSummary(last.id) : null);
  } catch (err) {
    next(err);
  }
});

mailboxCheckRouter.get("/me/mail-sources/:id/checks/:check/stores", requireAuth, async (req, res, next) => {
  try {
    const checkId = await ownCheck(req);
    if (!checkId) return void notFound(res);
    res.json({ items: await checkByYearAndStore(checkId) });
  } catch (err) {
    next(err);
  }
});

const LISTS = ["misses", "false-hits", "ask-ai", "orders", "all"] as const;

mailboxCheckRouter.get("/me/mail-sources/:id/checks/:check/items", requireAuth, async (req, res, next) => {
  try {
    const checkId = await ownCheck(req);
    if (!checkId) return void notFound(res);
    const list = (LISTS as readonly string[]).includes(String(req.query.list)) ? (String(req.query.list) as ReviewList) : "all";
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    res.json({ ...(await checkItems(checkId, list, limit, offset)), limit, offset });
  } catch (err) {
    next(err);
  }
});

const Verdict = z.object({ is_order: z.boolean() });

// AI-REACH: exempt — the person's own judgement of their own mail, which is what tunes the rules; an assistant's guess would teach them nothing.
// UI-SCREEN: /me/connections
mailboxCheckRouter.post("/me/mail-sources/:id/checks/:check/items/:gmail/verdict", requireAuth, async (req, res, next) => {
  try {
    const checkId = await ownCheck(req);
    if (!checkId) return void notFound(res);
    const parsed = Verdict.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: { code: "bad_body", message: "is_order is true or false." } });
      return;
    }
    const out = await recordVerdict(checkId, req.session!.id, String(req.params.gmail ?? ""), parsed.data.is_order);
    if (!out) return void notFound(res);
    res.json({ ok: true, remembered_for: out.sender_domain });
  } catch (err) {
    next(err);
  }
});

mailboxCheckRouter.get("/me/mail-sources/:id/checks/:check/marked", requireAuth, async (req, res, next) => {
  try {
    const checkId = await ownCheck(req);
    if (!checkId) return void notFound(res);
    res.json({ items: await markedForFixtures(checkId) });
  } catch (err) {
    next(err);
  }
});

// AI-REACH: exempt — stopping a read of the person's own mailbox is theirs.
// UI-SCREEN: /me/connections
mailboxCheckRouter.post("/me/mail-sources/:id/checks/:check/stop", requireAuth, async (req, res, next) => {
  try {
    const checkId = await ownCheck(req);
    if (!checkId) return void notFound(res);
    await meta.updateTable("mailbox_checks").set({ status: "stopped", finished_at: new Date(), updated_at: new Date() }).where("id", "=", checkId).where("status", "=", "running").execute();
    res.json(await checkSummary(checkId));
  } catch (err) {
    next(err);
  }
});
