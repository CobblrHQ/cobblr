import { useRunAction } from "@cobblr/platform-web";
export function useProductionAction() {
 // PRESS-ARGS: every production press passes its operation and the fields the page already collected; nothing is asked after the press
 const run = useRunAction();
 return async <T,>(action: "production-test" | "production-control" | "production-abort" | "production-read", operation: string, fields: Record<string, unknown>): Promise<T> => {
  const answer = await run({ actionId: `digifab:${action}`, args: action === "production-abort" ? { id: fields.id } : { operation, fields } });
  const result = answer.result as { ok?: boolean; error?: string; result?: T };
  if (!answer.ok || result?.ok !== true) throw new Error(result?.error || "Production test could not finish this action.");
  return result.result as T;
 };
}
