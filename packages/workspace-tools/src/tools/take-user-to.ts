import { z } from "zod";
import { toolFail, toolOk } from "../api.js";
import { ESCORT_DESTINATIONS } from "../escort-destinations.js";
import { type WorkspaceTool } from "../tool-kit.js";

const tool: WorkspaceTool = {
  name: "take_user_to",
  // Why each destination is an escort and not an action lives on the
  // destination (ESCORT_DESTINATIONS.why); lint:escort-claims keeps the
  // covered_by list honest. The sentences here are only what a model needs
  // to choose this tool and to NOT choose it over an action - the longer
  // rationale that used to sit here cost 900 chars on every turn.
  description:
    "ESCORT to configuration you cannot operate (prefill, never submit). An action: list_actions, never an escort. Destinations: " +
    ESCORT_DESTINATIONS.map(
      (d) =>
        `${d.id} (${d.why}${d.covered_by?.length ? `; actions: ${d.covered_by.join(", ")}` : ""})`,
    ).join("; ") +
    ".",
  mode: "read",
  paging: { by: "one-call", why: "moves the screen; returns no rows" },
  params: {
    destination: z
      .string()
      .describe(`One of: ${ESCORT_DESTINATIONS.map((d) => d.id).join(", ")}`),
    email: z.string().optional().describe("members only: invitee email"),
    role: z.string().optional().describe("members only: role"),
  },
  execute: async (_api, args) => {
    const id = typeof args.destination === "string" ? args.destination.trim().toLowerCase() : "";
    const dest = ESCORT_DESTINATIONS.find((d) => d.id === id);
    if (!dest) {
      return toolFail(
        `no such destination — use one of: ${ESCORT_DESTINATIONS.map((d) => d.id).join(", ")}`,
      );
    }
    // Only the keys the destination DECLARES ride along; anything else is
    // dropped, so a page can trust that every prefill.* param it reads was
    // meant for it.
    const params = new URLSearchParams();
    for (const key of Object.keys(dest.prefill)) {
      const v = args[key];
      if (typeof v === "string" && v.trim()) params.set(`prefill.${key}`, v.trim());
    }
    const qs = params.toString();
    return toolOk({
      escort: { path: qs ? `${dest.path}?${qs}` : dest.path, label: dest.label },
      note:
        "The user's screen is moving there now (in-app). Nothing was submitted — tell them what to press to finish, and why this one is theirs to press.",
    });
  },
};

export default tool;
