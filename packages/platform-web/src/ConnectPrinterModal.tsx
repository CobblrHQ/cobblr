// One door for connecting a label printer.
//
// WHY THIS EXISTS: the UI used to offer "Connect a Bluetooth printer" and
// "Connect a serial printer" side by side. Those are OUR two transports, not two
// kinds of product. To the person holding the printer both are simply "my
// Bluetooth label printer" — the box says Bluetooth, the printer says Bluetooth,
// and which browser API reaches it is an implementation detail they cannot
// possibly be expected to pick correctly. Offering the choice guaranteed a wrong
// guess roughly half the time and made a working printer look broken.
//
// So: one action. We try the common path first, and if the printer is not there
// we say so in the printer's own terms and offer the other path as "look again",
// never as a technology the user must understand.
//
// GESTURE RULE: each chooser must be opened by its own click. Chaining the
// second automatically after the first fails does not work — the user
// activation from the original click has expired by then, so requestPort()
// throws instead of opening. That is why the fallback is a BUTTON, not a
// silent retry.

import { useState } from "react";
import { Modal } from "./Modal";
import { pairBluetoothPrinter } from "./bluetooth-label";
import {
  isWebSerialAvailable, NO_WEB_SERIAL, pairSerialPrinter, identifySerialPrinter,
} from "./serial-printer.js";
import { explainPairingFailure } from "./pairing-errors.js";
import { setPrinterStatus } from "./printer-status.js";
import type { BluetoothPrinterSettings } from "./bluetooth-label";

export interface ConnectPrinterInput {
  name: string;
  driver: "browser-bluetooth" | "browser-serial";
  settings: Record<string, unknown>;
}

export interface ConnectPrinterModalProps {
  open: boolean;
  onClose: () => void;
  /** Persist the printer. The caller owns the API shape (page vs module). */
  createPrinter: (input: ConnectPrinterInput) => Promise<string | void>;
  /** Unrecognised model — the caller opens its own manual setup form. */
  onNeedsManualSetup?: (driver: "browser-bluetooth" | "browser-serial") => void;
  onConnected?: (name: string) => void;
}

type Stage = "start" | "searching" | "not-found";

export function ConnectPrinterModal(props: ConnectPrinterModalProps) {
  const { open, onClose, createPrinter, onNeedsManualSetup, onConnected } = props;
  const [stage, setStage] = useState<Stage>("start");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => { setStage("start"); setError(null); setBusy(false); };
  const close = () => { reset(); onClose(); };

  /** The common path: a BLE printer, straight from the browser. */
  const searchBluetooth = async () => {
    setBusy(true);
    setError(null);
    try {
      const { deviceName, profile, settings } = await pairBluetoothPrinter();
      if (!profile || !settings) {
        onNeedsManualSetup?.("browser-bluetooth");
        close();
        return;
      }
      await createPrinter({
        name: profile.label,
        driver: "browser-bluetooth",
        settings: settings as unknown as Record<string, unknown>,
      });
      onConnected?.(profile.label || deviceName);
      close();
    } catch (e) {
      const { message, remedy } = explainPairingFailure(e);
      // A cancelled chooser means "I did not see it", which is exactly the
      // situation the second step is for — so offer it rather than doing nothing.
      if (remedy === "serial" || !message) {
        setStage("not-found");
        setError(message || null);
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  };

  /** The other path, described by what the user did — paired it on the computer —
   *  rather than by the API we happen to use to reach it. */
  const searchPaired = async () => {
    if (!isWebSerialAvailable()) { setError(NO_WEB_SERIAL); return; }
    setBusy(true);
    setError(null);
    try {
      const session = await pairSerialPrinter();
      const id = await identifySerialPrinter(session);
      if (!id.responded) {
        setError(
          "Found the printer but it did not respond. Switch it off and on, then try again. " +
          "If it stays quiet, remove it from your computer's Bluetooth settings and pair it again.",
        );
        return;
      }
      // NEVER INVENT A MEDIA SIZE. An earlier version defaulted to 40 x 30 when
      // the printer reported nothing, which is a guess printed onto physical
      // labels — wrong size means wasted stock, and the user has no idea a
      // number they never entered came from us. A printer that cannot tell us
      // its roll goes to the manual form instead, saying so plainly.
      if (!id.widthMm || !id.heightMm) {
        setError(
          "Connected, but this printer did not report its media size — that is normal for a roll " +
          "with no size code in it. Set the label size by hand to finish.",
        );
        onNeedsManualSetup?.("browser-serial");
        return;
      }
      const widthMm = id.widthMm;
      const heightMm = id.heightMm;
      const settings: BluetoothPrinterSettings = {
        protocol: "tspl",
        widthDots: Math.round((widthMm / 25.4) * 203),
        labelHeightMm: heightMm,
        gapMm: 6,
        direction: 0,
        density: 10,
        media: { widthMm, heightMm, feed: "die-cut", gapMm: 6 },
        label: { widthMm, heightMm },
      };
      const createdId = await createPrinter({
        // Web Serial hides the port name, so there is no model to use. The roll
        // it reported is the most identifying thing available, and beats a row
        // of identical "Label printer" entries once you own two.
        name: `Label printer (${widthMm} × ${heightMm} mm)`,
        driver: "browser-serial",
        settings: settings as unknown as Record<string, unknown>,
      });
      // We just talked to it, so bank the reading rather than asking again later
      // — each ask costs a session on this hardware.
      if (typeof createdId === "string") {
        setPrinterStatus(createdId, {
          widthMm: id.widthMm, heightMm: id.heightMm, battery: id.battery, responded: id.responded,
        });
      }
      onConnected?.(`Label printer (${widthMm} × ${heightMm} mm roll)`);
      close();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/No port selected|cancell?ed/i.test(msg)) setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={close} title="Connect a printer">
      <div className="space-y-4">
        {stage === "start" && (
          <>
            <p className="text-sm text-muted dark:text-slate-400">
              Turn your label printer on and keep it nearby. Most connect over Bluetooth
              straight from this browser.
            </p>
            <button
              onClick={() => void searchBluetooth()}
              disabled={busy}
              className="w-full rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-2 text-sm font-medium transition disabled:opacity-60"
            >
              {busy ? "Searching…" : "Search for my printer"}
            </button>
            {isWebSerialAvailable() && (
              <button
                onClick={() => setStage("not-found")}
                className="w-full text-xs text-muted hover:text-accent hover:underline"
              >
                I already paired it in my computer&apos;s Bluetooth settings
              </button>
            )}
          </>
        )}

        {stage === "not-found" && (
          <>
            <p className="text-sm text-muted dark:text-slate-400">
              Some label printers, often the ones that come with a USB cable, have to be paired
              in your computer&apos;s Bluetooth settings first. Once they are paired, they show up
              in a different list.
            </p>
            <ol className="text-xs text-muted dark:text-slate-400 list-decimal ml-4 space-y-1">
              <li>Pair the printer in your computer&apos;s Bluetooth settings.</li>
              <li>Press the button below and pick your printer from the list.</li>
              <li>
                If it appears more than once, try each one — which entry works varies
                by computer and printer.
              </li>
            </ol>
            <button
              onClick={() => void searchPaired()}
              disabled={busy}
              className="w-full rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-2 text-sm font-medium transition disabled:opacity-60"
            >
              {busy ? "Connecting…" : "Find my paired printer"}
            </button>
            <button
              onClick={() => { setStage("start"); setError(null); }}
              className="w-full text-xs text-muted hover:text-accent hover:underline"
            >
              Back
            </button>
          </>
        )}

        {error && (
          <div className="rounded border border-ember-300 dark:border-ember-800/60 bg-ember-50 dark:bg-ember-900/20 p-3 text-xs text-content dark:text-mortar-200">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}
