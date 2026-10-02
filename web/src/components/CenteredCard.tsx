// A page of one card in the middle of the screen: the invite pages, before a
// person is in a workspace.

import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";

export function CenteredCard({
  title,
  tone,
  children,
}: {
  title: string;
  tone: "info" | "error";
  children: ReactNode;
}) {
  const Icon = tone === "error" ? AlertTriangle : CheckCircle2;
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="max-w-md w-full rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-6">
        <div
          className={
            "flex items-center gap-2 mb-3 " +
            (tone === "error" ? "text-ember-500" : "text-accent")
          }
        >
          <Icon size={16} />
          <h1 className="font-display text-lg font-bold text-content dark:text-mortar-100 page-title">
            {title}
          </h1>
        </div>
        {children}
      </div>
    </div>
  );
}

