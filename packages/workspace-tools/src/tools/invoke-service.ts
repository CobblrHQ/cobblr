import { z } from "zod";
import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { type WorkspaceTool } from "../tool-kit.js";

const tool: WorkspaceTool = {
  name: "invoke_service",
  sentWhen: "services",
  description:
    "Start a service job: capability, input per its schema, files by name as file ids. Returns at once. A physical or paid job waits for the person's confirm on its card: say it is waiting, never done. Follow with get_service_job.",
  mode: "write",
  consentBy: "service-gate",
  params: {
    capability: z.string().describe("e.g. slice.model"),
    input: z.record(z.unknown()),
    files: z.record(z.string()).optional().describe("{name: file id}"),
    attach_kind: z.string().optional().describe("Attach outputs to this record's kind"),
    attach_id: z.string().optional(),
    after: z.string().optional().describe("Run after job/print id"),
  },
  execute: async (api, args) => {
    const attach = typeof args.attach_kind === "string" && typeof args.attach_id === "string" ? { kind: args.attach_kind, id: args.attach_id } : undefined;
    const res = await api.request("POST", "/services/jobs", {
      capability: String(args.capability ?? ""),
      input: (args.input as Record<string, unknown> | undefined) ?? {},
      ...(args.files ? { files: args.files } : {}),
      ...(attach ? { attach_to: attach } : {}),
    });
    if (res.status >= 400) return toolFail(apiErrorMessage(res, "the service job could not be started"));
    const job = (res.body.job ?? res.body) as { id?: string; status?: string; message?: string | null; capability?: string };
    // "Power off after this print": the job waits for a yes either way;
    // the trigger makes that yes arm it for when the other thing finishes.
    let when: string | null = null;
    if (typeof args.after === "string" && args.after.trim() && job.id && job.status === "awaiting_confirm") {
      const t = await api.request("POST", `/services/jobs/${encodeURIComponent(job.id)}/trigger`, { after: args.after.trim() });
      if (t.status >= 400) return toolFail(apiErrorMessage(t, "the job was started but cannot wait for that"));
      when = ((t.body.trigger as { label?: string } | null)?.label as string | undefined) ?? null;
    }
    return toolOk({
      job_id: job.id,
      capability: job.capability,
      status: job.status,
      ...(job.status === "awaiting_confirm" ? { waiting_for: when ? `the person's yes on its card, then ${when}` : "the person to confirm it on its card" } : {}),
      ...(job.message ? { message: job.message } : {}),
    });
  },
};

export default tool;
