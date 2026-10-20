// Reading a print directive out of an action's result, apart from running it
// (print-directive.ts). Every action run asks this; only a result that carries
// a directive needs the printer drivers, which load then (#4945).
import type { LabelContent } from "./bluetooth-label";
import type { PrintDirective } from "./print-directive";

/** Pull a directive out of an action result, if there is one. Shape-checked
 *  rather than trusted: an action can return anything. */
export function printDirectiveOf(result: unknown): PrintDirective | null {
  const ui = (result as { ui?: { print?: unknown } } | undefined)?.ui?.print;
  if (!ui || typeof ui !== "object") return null;
  const d = ui as Partial<PrintDirective>;
  if (!d.content || typeof d.content !== "object") return null;
  const c = d.content as Partial<LabelContent>;
  if (typeof c.qrPayload !== "string" || c.qrPayload === "") return null;
  const rec = d.record;
  const record = rec && typeof rec.path === "string" && rec.body !== undefined ? { path: rec.path, body: rec.body } : undefined;
  return { content: { qrPayload: c.qrPayload, caption: c.caption }, record };
}
