// One bridged printer's state, with the controls that match it.
//
// The shape and wording come from the mockup the author approved: the ring carries the
// state as colour, the facts sit under it, and the buttons offered are only the
// ones that mean something in the state shown. A Connect button on an instance
// that opens per job would be a button that could never stay pressed.
//
// Nothing here holds a connection. The bridge does, which is why this survives a
// refresh and why several tabs can show the same printer at once — each is a
// view, not an owner.

import { useState } from "react";
import { Printer, TriangleAlert, PlugZap } from "lucide-react";
import type { BridgeInstanceLive } from "./bridge-live.js";
import { setBridgeLink } from "./bridge-live.js";
import { BatteryGauge } from "./BatteryGauge";
import { usePrinterStatus } from "./printer-status.js";
import { printerDisplayName } from "./bridge-printer.js";

const TONE: Record<string, { ring: string; chip: string; word: string }> = {
  connected: {
    ring: "border-[#6B8E4E] bg-[#6B8E4E]/15 text-[#4f6c39] dark:text-[#a9c48c]",
    chip: "text-moss-600 dark:text-moss-300 border-moss-400/50 bg-moss-500/10",
    word: "connected",
  },
  printing: {
    ring: "border-cobble-500 bg-cobble-500/15 text-cobble-700 dark:text-cobble-300 animate-pulse",
    chip: "text-accent border-cobble-400/50 bg-cobble-500/10",
    word: "printing",
  },
  idle: {
    ring: "border-slate-400 dark:border-slate-600 text-muted dark:text-slate-400",
    chip: "text-muted dark:text-slate-400 border-line dark:border-slate-700",
    word: "idle",
  },
  "per-job": {
    ring: "border-slate-400 dark:border-slate-600 text-muted dark:text-slate-400",
    chip: "text-muted dark:text-slate-400 border-line dark:border-slate-700",
    word: "ready",
  },
  unreachable: {
    ring: "border-amber-500 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    chip: "text-amber-600 dark:text-amber-400 border-amber-400/50 bg-amber-500/10",
    word: "not answering",
  },
};

export function BridgePrinterCard({
  printer,
  printerId,
  bridgeUrl,
  onChanged,
  onCheck,
}: {
  printer: BridgeInstanceLive;
  /** The Cobblr printer row id, when this instance is one — unlocks the
   *  remembered roll/battery reading for the facts line. */
  printerId?: string;
  bridgeUrl?: string;
  onChanged: () => void;
  /** Ask the printer what it has loaded. Owned by the caller because it also
   *  writes the reading into the shared status store. */
  onCheck?: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState<null | "connect" | "disconnect">(null);
  const [failed, setFailed] = useState<string | null>(null);
  const reading = usePrinterStatus(printerId ?? null);
  const tone = TONE[failed ? "unreachable" : printer.link] ?? TONE.idle!;

  const act = async (want: "connect" | "disconnect") => {
    setBusy(want);
    setFailed(null);
    const r = await setBridgeLink(printer.instance, want, bridgeUrl);
    setBusy(null);
    if (!r.ok) setFailed(r.detail ?? "the printer did not answer");
    onChanged();
  };

  const roll =
    reading?.widthMm && reading?.heightMm
      ? `${reading.widthMm} × ${reading.heightMm} mm`
      : printer.media?.widthMm
        ? `${printer.media.widthMm} mm wide`
        : null;

  return (
    <div className="rounded-lg border border-line dark:border-slate-700 p-2">
      <div className="flex items-center gap-2.5">
        <span
          className={"relative shrink-0 grid place-items-center rounded-full border-2 w-[32px] h-[32px] transition " + tone.ring}
        >
          {failed ? <TriangleAlert size={15} /> : <Printer size={15} />}
        </span>
        <div className="min-w-0">
          <div className="font-semibold text-[12.5px] leading-tight text-content dark:text-mortar-100 truncate">
            {printerDisplayName(printer.name)}
          </div>
          <div className="text-[10px] text-faint dark:text-slate-500 truncate">via bridge · {printer.instance}</div>
        </div>
        <span className={"ml-auto shrink-0 text-[10px] px-1.5 py-0.5 rounded-full border " + tone.chip}>
          {busy ? (busy === "connect" ? "connecting…" : "releasing…") : tone.word}
        </span>
      </div>

      {(roll || reading?.battery) && (
        <div className="mt-1.5 ml-[42px] flex items-center gap-2.5 text-[11px] text-muted dark:text-slate-400">
          {roll && <span>{roll}</span>}
          {reading?.battery && <BatteryGauge battery={reading.battery} />}
        </div>
      )}

      <div className="mt-1.5 ml-[42px] flex flex-wrap gap-1.5">
        {/* Only what means something here. A per-job instance is never offered
            Connect, because releasing after each job is what it is FOR. */}
        {printer.link === "idle" && (
          <CardButton primary busy={busy === "connect"} onClick={() => void act("connect")}>
            <PlugZap size={12} /> Connect
          </CardButton>
        )}
        {printer.link === "connected" && (
          <CardButton busy={busy === "disconnect"} onClick={() => void act("disconnect")}>
            Disconnect
          </CardButton>
        )}
        {onCheck && printer.link !== "printing" && (
          <CardButton onClick={() => void onCheck()}>Check</CardButton>
        )}
      </div>

      {failed && (
        <p className="mt-1.5 ml-[42px] text-[10.5px] leading-snug text-amber-600 dark:text-amber-400">{failed}</p>
      )}
      {!failed && printer.link === "per-job" && (
        <p className="mt-1.5 ml-[42px] text-[10.5px] leading-snug text-faint dark:text-slate-500">
          Opens a link for each job. Set <code>keepOpen</code> on this instance to hold one and print instantly.
        </p>
      )}
      {!failed && printer.link === "connected" && (
        <p className="mt-1.5 ml-[42px] text-[10.5px] leading-snug text-faint dark:text-slate-500">
          Held open by the bridge, so it survives refreshing and closing this tab.
        </p>
      )}
    </div>
  );
}

function CardButton({
  children,
  onClick,
  primary,
  busy,
}: {
  children: React.ReactNode;
  onClick: () => void;
  primary?: boolean;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] transition disabled:opacity-60 " +
        (primary
          ? "border-moss-400/60 text-moss-600 dark:text-moss-300 hover:bg-moss-500/10"
          : "border-line dark:border-slate-700 text-muted dark:text-slate-400 hover:border-accent hover:text-accent")
      }
    >
      {busy ? "working…" : children}
    </button>
  );
}
