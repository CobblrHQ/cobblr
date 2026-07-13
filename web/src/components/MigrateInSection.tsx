// "Migrate in from another app" — a section on the Integrations page for
// imports FROM other inventory systems (as opposed to the ongoing live-sync
// connectors above). This is APP-FIRST: you pick the app you're coming from
// (Homebox is the first; Snipe-IT etc. slot in as more entries), and only THEN
// choose how (live connect vs CSV) in a second step. That keeps any one app
// from dominating the section and scales as more sources arrive.

import { useState } from "react";
import { Download, ArrowRight, Zap, FileUp, type LucideIcon } from "lucide-react";
import { Modal } from "@cobblr/platform-web";
import { HomeboxImportModal } from "./HomeboxImportModal";
import { HomeboxLiveImportModal } from "./HomeboxLiveImportModal";

type Method = { id: string; label: string; desc: string; icon: LucideIcon };
type Source = { id: string; name: string; blurb: string; methods: Method[] };

// One entry per app you can migrate FROM. A source declares its own methods;
// a single-method source skips the chooser and opens straight through.
const SOURCES: Source[] = [
  {
    id: "homebox",
    name: "Homebox",
    blurb: "Bring your Homebox inventory into Cobblr.",
    methods: [
      {
        id: "live",
        label: "Live connect",
        desc: "Connect with your Homebox URL + API token. Items, locations, custom fields, and photos come across. Import once, or keep it synced.",
        icon: Zap,
      },
      {
        id: "csv",
        label: "CSV upload",
        desc: "No API access? Upload a Homebox CSV export instead — items, the location hierarchy, and labels come across (photos aren't in the CSV).",
        icon: FileUp,
      },
    ],
  },
];

export function MigrateInSection() {
  // The app whose method chooser is open (null = none).
  const [picked, setPicked] = useState<Source | null>(null);
  const [homeboxLive, setHomeboxLive] = useState(false);
  const [homeboxCsv, setHomeboxCsv] = useState(false);

  function runMethod(sourceId: string, methodId: string) {
    setPicked(null);
    if (sourceId === "homebox" && methodId === "live") setHomeboxLive(true);
    else if (sourceId === "homebox" && methodId === "csv") setHomeboxCsv(true);
  }

  function openSource(s: Source) {
    // Single method → skip the chooser; multiple → open it.
    if (s.methods.length === 1) runMethod(s.id, s.methods[0]!.id);
    else setPicked(s);
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Download className="h-4 w-4" /> Migrate from another app
        </h2>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {SOURCES.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => openSource(s)}
            className="text-left rounded-lg border border-line dark:border-slate-700 hover:border-cobble-400 bg-surface dark:bg-slate-900 p-3 transition group min-w-0"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-content dark:text-mortar-100 truncate">{s.name}</span>
              <ArrowRight className="h-4 w-4 shrink-0 text-faint group-hover:text-accent transition" />
            </div>
            <p className="text-xs text-muted dark:text-slate-400 mt-1">{s.blurb}</p>
          </button>
        ))}
      </div>

      {/* Second step: how to bring THIS app in. */}
      <Modal
        open={!!picked}
        onClose={() => setPicked(null)}
        title={picked ? `Bring ${picked.name} in` : ""}
        subtitle="Choose how you want to migrate"
        size="md"
      >
        {picked && (
          <div className="space-y-2">
            {picked.methods.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => runMethod(picked.id, m.id)}
                className="w-full text-left rounded-lg border border-line dark:border-slate-700 hover:border-cobble-400 bg-surface dark:bg-slate-900 p-3 transition group min-w-0"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-content dark:text-mortar-100 flex items-center gap-1.5 min-w-0">
                    <m.icon className="h-3.5 w-3.5 shrink-0 text-accent" /> <span className="truncate">{m.label}</span>
                  </span>
                  <ArrowRight className="h-4 w-4 shrink-0 text-faint group-hover:text-accent transition" />
                </div>
                <p className="text-xs text-muted dark:text-slate-400 mt-1">{m.desc}</p>
              </button>
            ))}
          </div>
        )}
      </Modal>

      <HomeboxLiveImportModal open={homeboxLive} onClose={() => setHomeboxLive(false)} />
      <HomeboxImportModal open={homeboxCsv} onClose={() => setHomeboxCsv(false)} />
    </section>
  );
}
