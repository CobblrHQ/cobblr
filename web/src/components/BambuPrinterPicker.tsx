// One look for "the printers on a Bambu account", shared by the connect wizard
// (static review list) and the New-3D-printer modal (clickable, selectable). Pass
// onSelect to make the cards selectable; omit it for a read-only list.
import { Printer } from "lucide-react";
import type { BambuDiscoveredDevice } from "../lib/api";

export function BambuPrinterPicker({
  devices,
  selectedDevId,
  onSelect,
}: {
  devices: BambuDiscoveredDevice[];
  /** The currently-selected printer (only meaningful with onSelect). */
  selectedDevId?: string;
  /** Provide to make the cards clickable (selectable); omit for a static list. */
  onSelect?: (devId: string) => void;
}) {
  const base = "w-full flex items-center gap-2 px-2 py-1.5 rounded border text-left";
  return (
    <div className="space-y-1">
      {devices.map((d) => {
        const sel = !!onSelect && d.dev_id === selectedDevId;
        const inner = (
          <>
            <Printer size={13} className={sel ? "text-accent" : "text-faint"} />
            <span className="text-sm text-content dark:text-mortar-100 flex-1">
              {d.name}{d.model ? ` · ${d.model}` : ""}
            </span>
            <span className={"text-[10px] font-mono uppercase " + (d.online ? "text-emerald-500" : "text-faint")}>
              {d.online ? "online" : "offline"}
            </span>
          </>
        );
        return onSelect ? (
          <button
            key={d.dev_id}
            type="button"
            onClick={() => onSelect(d.dev_id)}
            className={base + " transition " + (sel ? "border-cobble-500 bg-subtle dark:bg-slate-800" : "border-line dark:border-slate-600 hover:border-cobble-400")}
          >
            {inner}
          </button>
        ) : (
          <div key={d.dev_id} className={base + " border-line dark:border-slate-600"}>
            {inner}
          </div>
        );
      })}
    </div>
  );
}
