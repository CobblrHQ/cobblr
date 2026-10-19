import { z } from "zod";
import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { type WorkspaceTool } from "../tool-kit.js";

const tool: WorkspaceTool = {
  name: "get_service_job",
  sentWhen: "services",
  description:
    "One service job: status, progress, what it asks when needs_input, and when done its output and files.",
  mode: "read",
  paging: { by: "one-call", why: "a job is one record, read whole" },
  params: { job_id: z.string() },
  execute: async (api, args) => {
    if (!args.job_id) return toolFail("which job? pass the job_id invoke_service returned");
    const res = await api.request("GET", `/services/jobs/${encodeURIComponent(String(args.job_id ?? ""))}`);
    if (res.status >= 400) return toolFail(apiErrorMessage(res, "couldn't read the job"));
    const j = (res.body.job ?? res.body) as {
      id?: string;
      capability?: string;
      status?: string;
      progress?: number | null;
      message?: string | null;
      needs?: { prompt?: string } | null;
      output?: unknown;
      files?: Array<{ name?: string; direction?: string; file_id?: string | null }>;
      error?: { code?: string; message?: string } | null;
    };
    return toolOk({
      job_id: j.id,
      capability: j.capability,
      status: j.status,
      progress: j.progress ?? null,
      ...(j.message ? { message: j.message } : {}),
      ...(j.status === "needs_input" && j.needs?.prompt ? { asking: j.needs.prompt } : {}),
      ...(j.status === "done" ? { output: j.output, files: (j.files ?? []).filter((f) => f.direction !== "in").map((f) => ({ name: f.name, file_id: f.file_id ?? null })) } : {}),
      ...(j.error ? { error: j.error.message ?? j.error.code } : {}),
    });
  },
};

export default tool;
