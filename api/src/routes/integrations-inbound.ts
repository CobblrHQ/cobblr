// /api/v1/integrations/:connector/:token/webhook — the unauthenticated
// inbound webhook receiver.
//
// Mounted outside the /orgs tree because the URL carries no slug —
// the token resolves to (org_id, inbound_id, connector_id) via
// cobblr_meta's integration_inbound_token_lookup table.
//
// Flow:
//   1. Resolve (token, connector) → row in lookup table.
//   2. Read the tenant's core_integrations_inbound_tokens row to get
//      per-token config (HMAC secret, signature header, etc.).
//   3. Dispatch to the registered inbound handler.
//   4. Write an audit row to the tenant DB. Best-effort, never blocks
//      the response.
//   5. Bump last_hit_at + hit_count on the inbound token row.
//
// See docs/modules/core-integrations.md.

import { Router, type Request, type Response, type NextFunction } from "express";
import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { getTenantDb } from "../db/tenant.js";
import * as integrationsImpl from "../platform/integrations.js";
import * as events from "../platform/events.js";

export const integrationsInboundRouter = Router({ mergeParams: true });

interface TokenLookupRow {
  token: string;
  org_id: string;
  inbound_id: string;
  connector_id: string;
  enabled: boolean;
}

interface InboundTokenRow {
  id: string;
  config: Record<string, unknown>;
  enabled: boolean;
}

integrationsInboundRouter.post(
  "/:connector/:token/webhook",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { connector, token } = req.params;
      if (!connector || !token) {
        res.status(400).json({ error: { code: "missing_params", message: "connector + token required" } });
        return;
      }
      const lookup = (await meta
        .selectFrom("integration_inbound_token_lookup")
        .selectAll()
        .where("token", "=", token)
        .where("connector_id", "=", connector)
        .executeTakeFirst()) as TokenLookupRow | undefined;
      if (!lookup) {
        res.status(404).json({ error: { code: "not_found", message: "token not found" } });
        return;
      }
      if (!lookup.enabled) {
        res.status(410).json({ error: { code: "revoked", message: "token revoked" } });
        return;
      }
      const handler = integrationsImpl.getInboundHandler(connector);
      if (!handler) {
        res.status(503).json({
          error: { code: "no_handler", message: `inbound handler ${connector} not registered` },
        });
        return;
      }
      const tdb = (await getTenantDb(lookup.org_id)) as unknown as {
        selectFrom: (t: string) => {
          select: (cols: string[]) => {
            where: (col: string, op: string, val: unknown) => {
              executeTakeFirst: () => Promise<InboundTokenRow | undefined>;
            };
          };
        };
        updateTable: (t: string) => {
          set: (v: unknown) => {
            where: (col: string, op: string, val: unknown) => { execute: () => Promise<unknown> };
          };
        };
        insertInto: (t: string) => {
          values: (v: Record<string, unknown>) => { execute: () => Promise<unknown> };
        };
      };
      const row = await tdb
        .selectFrom("core_integrations_inbound_tokens")
        .select(["id", "config", "enabled"])
        .where("id", "=", lookup.inbound_id)
        .executeTakeFirst();
      if (!row || !row.enabled) {
        res.status(410).json({ error: { code: "revoked", message: "token revoked on tenant side" } });
        return;
      }
      const start = Date.now();
      const result = await handler.handle(
        {
          headers: req.headers as Record<string, string | string[] | undefined>,
          body: req.body,
          rawBody: (req as unknown as { rawBody?: string }).rawBody,
        },
        {
          orgId: lookup.org_id,
          inboundRowId: row.id,
          config: row.config ?? {},
          emit: async (eventName, payload) => {
            await events.emit(eventName, payload);
          },
        },
      );
      const ms = Date.now() - start;

      // Bump hit counters + audit log — both best-effort. The
      // handler's response is what matters.
      try {
        await tdb
          .updateTable("core_integrations_inbound_tokens")
          .set({
            last_hit_at: new Date(),
            hit_count: sql`hit_count + 1` as never,
          })
          .where("id", "=", row.id)
          .execute();
      } catch (err) {
        console.error("[integrations-inbound] hit counter update failed:", err);
      }
      try {
        await tdb
          .insertInto("core_integrations_calls")
          .values({
            direction: "inbound",
            connector_id: connector,
            action_or_event: "webhook",
            status: result.status,
            ok: result.status < 400,
            error: null,
            request_meta: sql`${JSON.stringify({
              headers_subset: pickHeaders(req.headers),
            })}::jsonb` as never,
            ms,
          })
          .execute();
      } catch (err) {
        console.error("[integrations-inbound] audit insert failed:", err);
      }

      res.status(result.status).json(result.body ?? { ok: result.status < 400 });
    } catch (err) {
      next(err);
    }
  },
);

function pickHeaders(headers: Request["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["user-agent", "content-type", "x-forwarded-for"]) {
    const v = headers[k];
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
