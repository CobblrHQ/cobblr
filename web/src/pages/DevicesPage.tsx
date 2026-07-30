// /configuration/devices — everything physical this workspace reaches, in one
// place: the on-site edge bridges, the machine managers that run print jobs,
// and the document printers.
//
// These were three separate registry entries (Edge bridges / Digital
// fabrication / Printers) in the "machines & devices" group — a group with no
// primary tile, so all three were invisible until you found "Show advanced
// settings". Merged per the revamp (docs/design-decisions/configuration-revamp.md):
// one destination, three tabs, each embedding the page that already existed.

import { useSearchParams } from "react-router-dom";

import { usePageTitle } from "@cobblr/platform-web";
import { EdgeBridgesPage } from "./EdgeBridgesPage";
import { DigifabPage } from "./DigifabPage";
import { PrintPage } from "./PrintPage";

const TABS = [
  { id: "bridges", label: "Bridges" },
  { id: "machines", label: "Machine managers" },
  { id: "printers", label: "Printers" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export function DevicesPage() {
  usePageTitle("Devices");
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab");
  const tab: TabId = TABS.some((t) => t.id === raw) ? (raw as TabId) : "bridges";
  const go = (t: TabId) =>
    setParams(t === "bridges" ? {} : { tab: t }, { replace: true });

  const tabCls = (on: boolean) =>
    "px-3 py-2 text-sm font-medium border-b-2 -mb-px transition " +
    (on
      ? "border-cobble-600 text-content dark:text-mortar-100"
      : "border-transparent text-muted hover:text-content dark:hover:text-mortar-100");

  return (
    <div className="space-y-4">
      
      <div className="flex gap-1 border-b border-line dark:border-slate-700">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => go(t.id)}
            className={tabCls(tab === t.id)}
            aria-current={tab === t.id ? "page" : undefined}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "bridges" && <EdgeBridgesPage embedded />}
      {tab === "machines" && <DigifabPage setupOnly embedded />}
      {tab === "printers" && <PrintPage embedded />}
    </div>
  );
}
