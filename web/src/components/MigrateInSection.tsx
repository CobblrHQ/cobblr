// "Migrate in from another app" — a section on the Integrations page for
// imports FROM other inventory systems (as opposed to the ongoing live sync
// connectors above). Homebox is first, two ways in: a live connect (URL + API
// key — brings photos, and can be left running) and a CSV upload (offline,
// no photos). Snipe-IT etc. arrive as cards here as their interfaces warrant.

import { useState } from "react";
import { Download, ArrowRight, Zap, FileUp } from "lucide-react";
import { HomeboxImportModal } from "./HomeboxImportModal";
import { HomeboxLiveImportModal } from "./HomeboxLiveImportModal";

export function MigrateInSection() {
  const [homeboxCsv, setHomeboxCsv] = useState(false);
  const [homeboxLive, setHomeboxLive] = useState(false);
  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Download className="h-4 w-4" /> Migrate in from another app
        </h2>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => setHomeboxLive(true)}
          className="text-left rounded-lg border border-line dark:border-slate-700 hover:border-cobble-400 bg-surface dark:bg-slate-900 p-3 transition group"
        >
          <div className="flex items-center justify-between">
            <span className="font-medium text-content dark:text-mortar-100 flex items-center gap-1.5">
              <Zap className="h-3.5 w-3.5 text-accent" /> Homebox — live
            </span>
            <ArrowRight className="h-4 w-4 text-faint group-hover:text-accent transition" />
          </div>
          <p className="text-xs text-muted dark:text-slate-400 mt-1">
            Connect with your Homebox URL + API token. Items, locations, custom fields, and <strong>photos</strong>{" "}
            come across. Import once, or keep it synced.
          </p>
        </button>

        <button
          type="button"
          onClick={() => setHomeboxCsv(true)}
          className="text-left rounded-lg border border-line dark:border-slate-700 hover:border-cobble-400 bg-surface dark:bg-slate-900 p-3 transition group"
        >
          <div className="flex items-center justify-between">
            <span className="font-medium text-content dark:text-mortar-100 flex items-center gap-1.5">
              <FileUp className="h-3.5 w-3.5 text-faint" /> Homebox — CSV
            </span>
            <ArrowRight className="h-4 w-4 text-faint group-hover:text-accent transition" />
          </div>
          <p className="text-xs text-muted dark:text-slate-400 mt-1">
            No API access? Upload a Homebox CSV export instead — items, the location hierarchy, and labels come across
            (photos aren't in the CSV).
          </p>
        </button>
      </div>
      <HomeboxLiveImportModal open={homeboxLive} onClose={() => setHomeboxLive(false)} />
      <HomeboxImportModal open={homeboxCsv} onClose={() => setHomeboxCsv(false)} />
    </section>
  );
}
