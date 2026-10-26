import { type ReactNode } from "react";
import { ChevronDown, CopyPlus } from "lucide-react";
import { useFlowHost } from "./context";

export interface TemplateCreateArgs {
  kind?: string;
  instance?: string;
  scanItemId?: string;
  seed?: Record<string, unknown>;
}

export function NewFromTemplateButton({ args = {}, onOpen }: { args?: TemplateCreateArgs; onOpen?: () => void }) {
  const { openFlow } = useFlowHost();
  return (
    <button type="button" className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm text-content hover:bg-subtle dark:hover:bg-slate-800"
      onClick={() => { onOpen?.(); openFlow("core-templates:create", { ...args }); }}>
      <CopyPlus size={14} /> New from template
    </button>
  );
}

export function NewItemMenu({ children, ...args }: TemplateCreateArgs & { children: ReactNode }) {
  return (
    // Never wider than its row: its button's words wrap rather than run past a
    // phone ("New licence or subscription" at 200% text, #8430).
    <div className="inline-flex min-w-0 max-w-full items-center gap-1">
      {children}
      <details className="relative shrink-0">
        <summary aria-label="More ways to add" className="list-none cursor-pointer rounded-md border border-line dark:border-slate-600 p-2 text-content hover:bg-subtle dark:hover:bg-slate-800">
          <ChevronDown size={16} />
        </summary>
        <div className="absolute right-0 z-30 min-w-max rounded-md border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 shadow-lg">
          <NewFromTemplateButton args={args} />
        </div>
      </details>
    </div>
  );
}
