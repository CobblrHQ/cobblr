import { LABELS_OUTPUT_SCHEMA } from "@cobblr/platform-contract/ai-output-schemas";
// Built-in `llm` detector — the workspace's configured vision AI
// (core-ai classify-image). The zero-model fallback; bills tokens on a paid
// provider. Was an inline branch in detectOnce; now a package behind the
// registry.

import { parseJsonReply, platform } from "@cobblr/platform-contract";
import type { DetectorPackage } from "../types.js";
import { FAILURE_LABELS, FAILURE_PROMPT, parseFailureProbability } from "../vision.js";

export const builtin: DetectorPackage = {
  key: "llm",
  name: "Vision AI (classify-image)",
  summary: "The workspace's vision AI scores a camera frame. Works with no model.",
  score: async (ctx) => {
    const frame = await ctx.grabFrame();
    if (!frame) return null;
    // ai-userless: driver auto-detection scores a device frame during setup —
    // a system detection pass, not a user's AI request.
    const out = await platform().ai.invoke({
      orgId: ctx.orgId,
      capability: "classify-image",
      input: { output_schema: LABELS_OUTPUT_SCHEMA,
        prompt: FAILURE_PROMPT,
        labels: [...FAILURE_LABELS],
        image_b64: frame.toString("base64"),
        image_media_type: "image/jpeg",
      },
    });
    // The labels are in the answer's text: no adapter puts them on `result`,
    // so reading `result.labels` scored nothing, ever (#5790).
    const p = parseFailureProbability(parseJsonReply(out.text));
    return p == null ? null : { probability: p };
  },
};
