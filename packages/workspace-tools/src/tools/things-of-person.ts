import { z } from "zod";
import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { type WorkspaceTool } from "../tool-kit.js";

const tool: WorkspaceTool = {
  name: "things_of_person",
  // By name as said: the route resolves it on the People list (members and
  // anyone added by name), "me" is the asker, and a name matching two people
  // comes back as a question rather than a guess.
  description: "What one person owns, across every collection (\"what does Alex own\", \"my things\").",
  mode: "read",
  paging: { by: "one-call", why: "one person's things across every collection; a person owns tens of things, not thousands" },
  params: {
    person: z.string().describe("Their name as said, or \"me\""),
  },
  execute: async (api, args) => {
    const person = String(args.person ?? "").trim();
    if (!person) return toolFail("say whose things: a name, or me");
    const res = await api.request("GET", `/people/things?person=${encodeURIComponent(person)}`);
    if (res.status >= 400) return toolFail(apiErrorMessage(res, `couldn't find what belongs to ${person}`));
    return toolOk(res.body);
  },
};

export default tool;
