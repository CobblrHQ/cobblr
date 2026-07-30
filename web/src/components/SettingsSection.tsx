// One bordered section, with one header shape, for every block on a settings
// page.
//
// The page that forced this was Integrations, which grew THREE section
// treatments: a bordered card with a small icon heading, a bare `text-lg`
// heading with an unbordered box under it, and a mono `// LIVE SYNC` comment
// rule. All three on one screen, because each section was written on a
// different day and copied whichever neighbour was open.
//
// Same failure as the page headers: no individual section looks wrong, only the
// stack of them does. So the shape stops being something you retype.

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

interface Props {
  title: string;
  icon?: LucideIcon;
  /** One line under the title: what this section is for. */
  blurb?: string;
  /** The section's own control, rendered top-right (an "+ Add …" button). */
  action?: ReactNode;
  /** Anchor id, so a search hit or a deep link can land on the section. */
  id?: string;
  children: ReactNode;
}

export function SettingsSection({ title, icon: Icon, blurb, action, id, children }: Props) {
  return (
    <section
      id={id}
      className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 scroll-mt-20"
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-content dark:text-mortar-100 flex items-center gap-2">
            {Icon ? <Icon className="h-4 w-4 shrink-0" aria-hidden /> : null}
            {title}
          </h2>
          {blurb ? <p className="text-xs text-faint mt-0.5">{blurb}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}
