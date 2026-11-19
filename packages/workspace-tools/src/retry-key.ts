// A write an assistant sends again applies once (#4115).
//
// An MCP tool call that times out may still have run: the host gives up, the
// model (or the host) sends the same call again, and a create made a second
// record. The kernel already answers a write sent again with its
// Idempotency-Key from the first answer and runs nothing (request-replays.ts),
// so an MCP write tool takes a `request_id` the caller keeps for one intended
// change and sends again unchanged on a retry. Every write request the tool
// makes carries a key built from it, the tool and the arguments: the same call
// again is answered as the first was, and a different change that happens to
// reuse an id is a different key, never refused as a reused one.

import { createHash } from "node:crypto";
import { z } from "zod";
import type { WorkspaceApi } from "./api.js";

/** The argument an MCP write tool takes for this. */
export const RETRY_ARG = "request_id";

/** The parameter both MCP faces add to every write tool. */
export const RETRY_PARAM = {
  [RETRY_ARG]: z
    .string()
    .max(200)
    .optional()
    .describe(
      "Optional, recommended: a fresh id of your own for this one change (a uuid will do). If the call times out or its answer is lost, send the SAME call again with the SAME request_id: it applies once, and the second answer is the first one's. A new change gets a new id.",
    ),
} satisfies z.ZodRawShape;

/** A tool's parameters as an MCP face offers them: a write takes request_id too. */
export function mcpParamsOf(tool: { mode: "read" | "write"; params: z.ZodRawShape }): z.ZodRawShape {
  return tool.mode === "write" ? { ...tool.params, ...RETRY_PARAM } : tool.params;
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

/** The key one call's writes are sent under, or null when it named no
 *  request_id. The same tool, id and arguments always give the same key. */
export function retryKeyOf(tool: string, args: Record<string, unknown>): string | null {
  const id = args[RETRY_ARG];
  if (typeof id !== "string" || !id.trim()) return null;
  const { [RETRY_ARG]: _drop, ...rest } = args;
  const h = createHash("sha256").update(JSON.stringify([tool, id.trim(), canonical(rest)])).digest("hex").slice(0, 40);
  return `mcp.${h}`;
}

/** The call as the tool should run it: without `request_id` among its
 *  arguments, and over a transport that sends each write under the call's
 *  key, numbered in the order the tool makes them (a tool that makes the same
 *  requests again makes them in the same order). */
export function keyedCall(tool: string, api: WorkspaceApi, args: Record<string, unknown>): { api: WorkspaceApi; args: Record<string, unknown> } {
  if (!(RETRY_ARG in args)) return { api, args };
  const key = retryKeyOf(tool, args);
  const { [RETRY_ARG]: _drop, ...rest } = args;
  if (!key) return { api, args: rest };
  let n = 0;
  return {
    args: rest,
    api: {
      ...api,
      request(method, path, body, opts) {
        if (method === "GET") return api.request(method, path, body, opts);
        n += 1;
        return api.request(method, path, body, { ...opts, idempotencyKey: `${key}.${n}` });
      },
    },
  };
}
