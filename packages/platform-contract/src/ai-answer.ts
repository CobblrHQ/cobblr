// The words of an AI answer, whichever key the adapter put them under.
//
// Adapters answer chat as `{ role, content }` (the OpenAI message shape) and
// summarise and the vision jobs as `{ text }`; a cached reply is whatever shape
// was live when it was bought, and a provider outside this repo may answer
// either way, or with a bare string. So `platform().ai.invoke` returns this as
// `text`, worked out once, and no caller reads `result.text` or
// `result.content` itself. Fifteen callers used to hedge with both keys, in
// both orders, and five read only `content`: right only because each of them
// asked for chat, and wrong the day one moved to a job that answers `text`
// (#3499).

export function aiAnswerText(result: unknown): string {
  if (typeof result === "string") return result;
  if (typeof result !== "object" || result === null) return "";
  const r = result as { text?: unknown; content?: unknown };
  if (typeof r.text === "string") return r.text;
  if (typeof r.content === "string") return r.content;
  return "";
}
