// /api/v1/orgs/:slug/modules/labels/action-labels (#3897)
//
// An action label is a printed QR that a phone's own camera opens as a page
// saying what will happen ("Toilet paper: 12 → 11") with a Confirm. The label
// holds one or more buttons, each an existing action on a record with the
// arguments it is always pressed with, the same shape as a collection's own
// shortcut (#3802): nothing here runs anything. The page presses a button
// through the ordinary invoke door with the label's code beside it
// (api/src/routes/label-via.ts), so the permission check, the required
// arguments, the change ledger and Undo are the door's, and the history line
// says "via label 'Bathroom'".
//
// Reading a label never changes anything: `GET /by-code/:code` is a read, and
// a link preview or a second scan cannot take one off.

import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import { platform } from "@cobblr/platform-contract";
import { requiredArgsMissing, describeArgs, type ActionArgSpec } from "@cobblr/platform-contract/action-args";
import { sessionUser, tenantContext, tenantDb, type ActionLabelButton } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { effectiveBase, insertQrToken } from "./qr-tokens.js";

export const actionLabelsRouter = Router({ mergeParams: true });

/** The kind a label's own token names: not a record kind, a label. */
export const ACTION_LABEL_KIND = "labels:action-label";

const Button = z.object({
  entity_kind: z.string().min(1).max(120),
  entity_id: z.string().uuid(),
  action_id: z.string().min(1).max(120),
  binding_id: z.string().uuid().nullable().optional(),
  args: z.record(z.unknown()).optional(),
  label: z.string().trim().max(60).nullable().optional(),
});

const LabelCreate = z.object({
  title: z.string().trim().min(1).max(60),
  /** The words printed beside the code: "Took a pack? Scan me". */
  hint: z.string().trim().max(120).nullable().optional(),
  buttons: z.array(Button).min(1).max(8),
});

const LabelUpdate = z.object({
  title: z.string().trim().min(1).max(60).optional(),
  hint: z.string().trim().max(120).nullable().optional(),
  buttons: z.array(Button).min(1).max(8).optional(),
});

export function actionUrl(base: string, code: string): string {
  return `${base.replace(/\/+$/, "")}/a/${code}`;
}

/** Every button names a record that is there and an action that applies to
 *  it, and carries what the action requires: a label that could only ever be
 *  refused is not printed. The first problem, in words, or null. */
async function buttonProblem(orgId: string, b: z.infer<typeof Button>): Promise<string | null> {
  const title = await platform().entities.titleForEntity(orgId, b.entity_kind, b.entity_id).catch(() => null);
  if (!title) return "one of its records is not here any more";
  const actions = await platform().actions.listApplicable(b.entity_kind, orgId).catch(() => []);
  const action = actions.find((a) => a.id === b.action_id);
  if (!action) return `“${b.action_id}” is not something that can be done to ${title}`;
  // The page offers Undo after every press, and a scan is one thumb from a
  // mistake: a label only does what can be put back.
  if (action.undoable !== true) return `“${action.label}” can't be undone, so it can't go on a label`;
  const missing = requiredArgsMissing(action.args_schema as Record<string, ActionArgSpec> | null, b.args ?? {});
  if (b.binding_id || missing.length === 0) return null;
  return `“${action.label}” on ${title} needs ${describeArgs(action.args_schema as Record<string, ActionArgSpec> | null, missing)}, and a label cannot ask`;
}

async function setTokenTitle(tokenId: string, title: string): Promise<void> {
  const meta = platform().db.meta as unknown as {
    updateTable: (t: string) => { set: (v: unknown) => { where: (c: string, o: string, v: unknown) => { execute: () => Promise<unknown> } } };
  };
  await meta
    .updateTable("core_labels_qr_tokens")
    .set({ config: sql`jsonb_set(coalesce(config, '{}'::jsonb), '{title}', to_jsonb(${title}::text))` })
    .where("id", "=", tokenId)
    .execute();
}

async function setTokenRevoked(tokenId: string, revokedAt: Date | null): Promise<void> {
  const meta = platform().db.meta as unknown as {
    updateTable: (t: string) => { set: (v: unknown) => { where: (c: string, o: string, v: unknown) => { execute: () => Promise<unknown> } } };
  };
  await meta.updateTable("core_labels_qr_tokens").set({ revoked_at: revokedAt }).where("id", "=", tokenId).execute();
}

// AI-REACH: exempt a list of printed labels for the Labels page; the actions on them are the assistant's through invoke_action
actionLabelsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const base = await effectiveBase(req);
    // list-cap-ok: not paged yet, #4134
    const rows = await tenantDb(req).selectFrom("labels_action_labels").selectAll().orderBy("created_at", "desc").limit(200).execute();
    res.json({ items: rows.map((r) => ({ ...r, url: actionUrl(base, r.code) })) });
  }),
);

// AI-REACH: exempt the label page's read; it changes nothing, and the assistant never scans a label
actionLabelsRouter.get(
  "/by-code/:code(*)",
  asyncHandler(async (req, res) => {
    const code = String(req.params.code ?? "");
    const ctx = tenantContext(req);
    const row = await tenantDb(req).selectFrom("labels_action_labels").selectAll().where("code", "=", code).executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "This label isn't one of this workspace's." } });
      return;
    }
    if (row.revoked_at) {
      res.status(410).json({ error: { code: "label_revoked", message: "This label has been turned off, so it does nothing." }, title: row.title });
      return;
    }
    const buttons = await Promise.all(
      (row.buttons ?? []).map(async (b, index) => {
        const record_title = await platform().entities.titleForEntity(ctx.org.id, b.entity_kind, b.entity_id).catch(() => null);
        const actions = await platform().actions.listApplicable(b.entity_kind, ctx.org.id).catch(() => []);
        const action = actions.find((a) => a.id === b.action_id);
        return {
          index,
          ...b,
          record_title,
          action_label: action?.label ?? b.action_id,
          // A button whose record went away or whose action no longer applies
          // is shown as such, never pressed into a refusal.
          available: !!record_title && !!action,
        };
      }),
    );
    res.json({ id: row.id, code: row.code, title: row.title, hint: row.hint, buttons });
  }),
);

// AI-REACH: exempt making a printed label is a person's desk task; its buttons are actions the assistant already reaches
actionLabelsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = LabelCreate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    for (const b of parsed.data.buttons) {
      const problem = await buttonProblem(ctx.org.id, b);
      if (problem) {
        res.status(400).json({ error: { code: "bad_button", message: `This label can't be made: ${problem}.` } });
        return;
      }
    }
    const id = randomUUID();
    const token = await insertQrToken({
      orgId: ctx.org.id,
      entityKind: ACTION_LABEL_KIND,
      entityId: id,
      mode: "action",
      actionId: ACTION_LABEL_KIND,
      auth: "session",
      config: { title: parsed.data.title },
      expiresAt: null,
    });
    const row = await tenantDb(req)
      .insertInto("labels_action_labels")
      .values({
        id,
        token_id: token.id,
        code: token.token,
        title: parsed.data.title,
        hint: parsed.data.hint ?? null,
        buttons: sql`${JSON.stringify(parsed.data.buttons)}::jsonb` as never,
        created_by: sessionUser(req).id,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    res.status(201).json({ ...row, url: actionUrl(await effectiveBase(req), row.code) });
  }),
);

// AI-REACH: exempt renaming or re-buttoning a printed label is a person's desk task
actionLabelsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = LabelUpdate.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const ctx = tenantContext(req);
    const db = tenantDb(req);
    const before = await db.selectFrom("labels_action_labels").selectAll().where("id", "=", String(req.params.id)).executeTakeFirst();
    if (!before) {
      res.status(404).json({ error: { code: "not_found", message: "label not found" } });
      return;
    }
    for (const b of parsed.data.buttons ?? []) {
      const problem = await buttonProblem(ctx.org.id, b);
      if (problem) {
        res.status(400).json({ error: { code: "bad_button", message: `This label can't be changed like that: ${problem}.` } });
        return;
      }
    }
    const row = await db
      .updateTable("labels_action_labels")
      .set({
        ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
        ...(parsed.data.hint !== undefined ? { hint: parsed.data.hint } : {}),
        ...(parsed.data.buttons ? { buttons: sql`${JSON.stringify(parsed.data.buttons)}::jsonb` as never } : {}),
        updated_at: new Date(),
      })
      .where("id", "=", before.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    // The history line names the label by its title: keep the code's copy in step.
    if (parsed.data.title && parsed.data.title !== before.title) await setTokenTitle(before.token_id, parsed.data.title);
    res.json({ ...row, url: actionUrl(await effectiveBase(req), row.code) });
  }),
);

// AI-REACH: exempt turning a printed label off is a person's call about a thing on their wall
actionLabelsRouter.post(
  "/:id/revoke",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const db = tenantDb(req);
    const row = await db
      .updateTable("labels_action_labels")
      .set({ revoked_at: new Date(), updated_at: new Date() })
      .where("id", "=", String(req.params.id))
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "label not found" } });
      return;
    }
    await setTokenRevoked(row.token_id, new Date());
    res.json(row);
  }),
);

// A label turned off by mistake, or back in use: the same printed code works
// again. A turned-off label told whoever scanned it to reprint it, and Labels
// offered nothing for a turned-off row, so there was no way back (#3992).
// AI-REACH: exempt turning a printed label back on is a person's call about a thing on their wall
actionLabelsRouter.post(
  "/:id/restore",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const db = tenantDb(req);
    const row = await db
      .updateTable("labels_action_labels")
      .set({ revoked_at: null, updated_at: new Date() })
      .where("id", "=", String(req.params.id))
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "label not found" } });
      return;
    }
    await setTokenRevoked(row.token_id, null);
    res.json({ ...row, url: actionUrl(await effectiveBase(req), row.code) });
  }),
);

// AI-REACH: exempt printing is a person at a printer; the assistant never queues a label it cannot see
actionLabelsRouter.post(
  "/:id/print",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const db = tenantDb(req);
    const row = await db.selectFrom("labels_action_labels").selectAll().where("id", "=", String(req.params.id)).executeTakeFirst();
    if (!row || row.revoked_at) {
      res.status(row ? 410 : 404).json({ error: { code: row ? "label_revoked" : "not_found", message: row ? "This label has been turned off." : "label not found" } });
      return;
    }
    const qty = Math.max(1, Math.min(20, Math.trunc(Number((req.body as { qty?: unknown })?.qty ?? 1)) || 1));
    const queued = await db
      .insertInto("labels_queue")
      .values({
        user_id: sessionUser(req).id,
        module_name: "labels",
        entity_type: "action-label",
        entity_id: row.id,
        qr_payload: actionUrl(await effectiveBase(req), row.code),
        description: row.hint?.trim() || row.title,
        qty,
      } as never)
      .returningAll()
      .executeTakeFirstOrThrow();
    res.status(201).json({ queued });
  }),
);

export type { ActionLabelButton };
