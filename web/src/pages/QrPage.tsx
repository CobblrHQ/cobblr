// One "QR codes" settings window with two tabs — the minted QR tokens and the
// external-QR resolver rules — instead of two separate Configuration entries for
// the same concept. Each tab embeds its existing page (passing `embedded` so the
// page drops its own outer container + title and renders inside this one).
//
// Deep-linkable: ?tab=rules opens the rules tab (so old /configuration/scan-rules
// links redirect here cleanly).

import { useSearchParams } from "react-router-dom";
import { QrCode } from "lucide-react";
import { QrTokensPage } from "./QrTokensPage";
import { ScanRulesPage } from "./ScanRulesPage";

export function QrPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "rules" ? "rules" : "tokens";
  const go = (t: "tokens" | "rules") => setParams(t === "rules" ? { tab: "rules" } : {}, { replace: true });
  const tabCls = (on: boolean) =>
    "px-3 py-2 text-sm font-medium border-b-2 -mb-px transition " +
    (on
      ? "border-cobble-600 text-content dark:text-mortar-100"
      : "border-transparent text-muted hover:text-content dark:hover:text-mortar-100");

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3 border-b border-line dark:border-slate-700 pb-3">
        <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 page-title flex items-center gap-2">
          <QrCode size={22} /> QR codes
        </h1>
      </div>

      <div className="flex gap-1 border-b border-line dark:border-slate-700">
        <button type="button" onClick={() => go("tokens")} className={tabCls(tab === "tokens")}>
          Tokens
        </button>
        <button type="button" onClick={() => go("rules")} className={tabCls(tab === "rules")}>
          External rules
        </button>
      </div>

      {tab === "tokens" ? <QrTokensPage embedded /> : <ScanRulesPage />}
    </div>
  );
}
