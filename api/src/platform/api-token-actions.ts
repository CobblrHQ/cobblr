// The assistant's (and any action caller's) door to ending a person's own API tokens. It finds them by the caller,
// so nobody reaches another person's. A token held to one workspace is refused at the door (may-invoke.ts).
import type { ActionInvokeContext } from "@cobblr/platform-contract";
import { registerHandler } from "./actions.js";
import { endApiTokensAndLog, endedSentence } from "./api-tokens-after-password.js";

export function registerApiTokenHandlers(): void {
  registerHandler("platform.end-my-api-tokens", async (ctx: ActionInvokeContext) => {
    if (!ctx.userId) return { ok: false, error: "API tokens are a person's own; this ran as nobody" };
    const reason = String(((ctx.args ?? {}) as { reason?: unknown }).reason ?? "").trim().slice(0, 200) || null;
    const ended = await endApiTokensAndLog(ctx.userId, reason);
    return { ok: true, summary: endedSentence(ended), data: ended };
  });
}
