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
// So: one action per WAY IN, and the ways in are not radios. There are exactly
// two, because the only thing a person can actually answer is whether they are
// willing to install something:
//
//   1. through this browser  — nothing to install, Bluetooth straight from here
//   2. through an edge bridge — a small app that reaches printers a browser
//                               cannot, keeps printing when the tab is closed,
//                               and works from a phone
//
// BLE versus Bluetooth Classic never surfaces. Door 1 tries the common path and
// then the other one; both are "look again", never a technology to pick.
//
// The DEVICE decides the order, by feature detection rather than user-agent
// sniffing: on Safari, Firefox, and anything on iOS there is no Web Bluetooth or
// Web Serial at all, so door 1 is disabled with a plain reason and door 2 leads.
// Offering a door that cannot work is how a working printer looks broken.
//
// GESTURE RULE: each chooser must be opened by its own click. Chaining the
// second automatically after the first fails does not work — the user
// activation from the original click has expired by then, so requestPort()
// throws instead of opening. That is why the fallback is a BUTTON, not a
// silent retry.

import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { pairBluetoothPrinter } from "./bluetooth-label";
import {
  isWebSerialAvailable, NO_WEB_SERIAL, pairSerialPrinter, identifySerialPrinter,
} from "./serial-printer.js";
import { explainPairingFailure } from "./pairing-errors.js";
import { discoverLocalPrinters, LOCAL_BRIDGE_URL, printerDisplayName, type DiscoveredPrinter } from "./bridge-printer.js";
import { isBleDecoy } from "./bluetooth-label";
import { isWebBluetoothAvailable } from "./bluetooth-label";
import { setPrinterStatus } from "./printer-status.js";
import type { BluetoothPrinterSettings } from "./bluetooth-label";

export interface ConnectPrinterInput {
  name: string;
  /** A bridge printer is nominally `cups`: routing through a bridge is a
   *  TRANSPORT chosen by the cobblr-edge:// manager URL, not a driver kind. */
  driver: "browser-bluetooth" | "browser-serial" | "cups";
  settings: Record<string, unknown>;
  /** Manager URL. Only a bridge printer sets one (`cobblr-edge://<instance>`);
   *  a browser-driven printer has no network address at all. */
  base_url?: string;
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

type Stage = "home" | "browser" | "not-found" | "bridge";

/** Run a bridge on THIS machine, for THIS browser.
 *
 *  Deliberately not the installer the docs hand out for a workshop Pi: that one
 *  takes a relay URL and a token because it dials out to Cobblr. A bridge whose
 *  only client is the browser on the same machine needs neither, and asking
 *  someone to mint a token so their own laptop can reach its own printer is the
 *  ceremony this whole flow exists to remove.
 *
 *  The address is the one thing we cannot know for them: the bridge has to be
 *  told which printer it is fronting before it can list anything. Pretending
 *  otherwise would produce a running bridge with nothing in it and no clue why. */
const INSTALL_CMD = [
  "docker run -d --name cobblr-edge-bridge --restart unless-stopped \\",
  "  -p 8077:8077 \\",
  "  -e BRIDGE_CONFIG='port: 8077",
  "instances:",
  "  - id: labels",
  "    driver: thermal",
  "    config:",
  "      transport: macrfcomm",
  "      mac: \"YOUR-PRINTER-ADDRESS\"",
  "      protocol: tspl' \\",
  // NOTE: this image is not published yet. It pointed at a private registry
  // on a tailnet, which only ever resolved for its maintainer; a public
  // address at least fails with a clear "not found" and becomes correct the
  // moment the image is pushed. Publish it before offering this door publicly.
  "  ghcr.io/cobblrhq/edge-bridge:latest",
].join("\n");

export function ConnectPrinterModal(props: ConnectPrinterModalProps) {
  const { open, onClose, createPrinter, onNeedsManualSetup, onConnected } = props;
  const [stage, setStage] = useState<Stage>("home");
  const [error, setError] = useState<string | null>(null);
  // Set when the failure has a known way out. An error we can route is not a
  // dead end, and showing it as one is how someone concludes their printer is
  // broken when it simply needs the other door.
  const [offerBridge, setOfferBridge] = useState(false);
  const [busy, setBusy] = useState(false);
  // Discovery runs while the person reads the two doors, so the bridge door can
  // already say what it found by the time they look at it.
  const [scanning, setScanning] = useState(false);
  const [found, setFound] = useState<DiscoveredPrinter[]>([]);

  // Feature detection, not user-agent sniffing: these are the actual capability.
  const canBrowser = isWebBluetoothAvailable() || isWebSerialAvailable();

  useEffect(() => {
    if (!open) return;
    let live = true;
    setScanning(true);
    void discoverLocalPrinters()
      .then((p) => { if (live) setFound(p); })
      .finally(() => { if (live) setScanning(false); });
    return () => { live = false; };
  }, [open]);

  const reset = () => { setStage("home"); setError(null); setOfferBridge(false); setBusy(false); };
  const close = () => { reset(); onClose(); };

  /** The common path: a BLE printer, straight from the browser. */
  const searchBluetooth = async () => {
    setBusy(true);
    setError(null);
    try {
      const { deviceName, profile, settings } = await pairBluetoothPrinter();
      // Some models advertise a Bluetooth tree that accepts every write and does
      // nothing. Pairing one produces a printer that looks connected and never
      // prints, so refuse and name the route that works instead.
      if (isBleDecoy(profile)) {
        setError(
          profile?.connectivity?.advice ??
            `${profile?.label ?? deviceName} cannot be driven from a browser. Connect it through an edge bridge.`,
        );
        setOfferBridge(true);
        return;
      }
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
      if (remedy === "bridge") { setError(message); setOfferBridge(true); return; }
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
          "Found the printer but it did not respond. Switch it off and on and try once more. " +
          "If it stays quiet, this printer probably cannot be driven from a browser — some " +
          "Bluetooth printers only respond to a native connection. It will still work through " +
          "an on-site bridge.",
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
      if (/No port selected|cancell?ed/i.test(msg)) return;
      // The serial door failing is the single most common way this flow ends on
      // macOS, and the reason is a browser bug. Route, do not dead-end.
      const { message, remedy } = explainPairingFailure(e);
      setError(remedy === "none" ? msg : message);
      if (remedy === "bridge") setOfferBridge(true);
    } finally {
      setBusy(false);
    }
  };

  /** Add a printer the bridge already has. Nothing is typed: the instance id and
   *  the bridge address come from what discovery found, and the printer's
   *  calibration stays in the bridge's own config where it belongs. */
  const addFromBridge = async (p: DiscoveredPrinter) => {
    setBusy(true);
    setError(null);
    try {
      const name = printerDisplayName(p.name);
      await createPrinter({
        name,
        driver: "cups",
        base_url: `cobblr-edge://${p.instance}`,
        // The bridge's own driver kind is recorded, not discarded: it is what
        // says this is a ROLL printer. Without it a bridged label printer read
        // as a network sheet printer and opened on US Letter.
        settings: { bridge: { instance: p.instance, bridgeUrl: LOCAL_BRIDGE_URL, driver: p.driver } },
      });
      onConnected?.(name);
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const title =
    stage === "browser" || stage === "not-found" ? "Through this browser"
    : stage === "bridge" ? "Through an edge bridge"
    : "Connect a printer";

  const backTo = (to: Stage) => () => { setStage(to); setError(null); setOfferBridge(false); };

  return (
    <Modal open={open} onClose={close} title={title}>
      <div className="space-y-4">
        {stage === "home" && (
          <>
            <p className="text-sm text-muted dark:text-slate-400">
              Turn your label printer on and keep it nearby.
            </p>
            {/* Order is decided by the DEVICE. A door it cannot use is never
                offered first, and never silently vanishes either — it stays,
                disabled, saying why in the printer's terms. */}
            {[canBrowser ? "browser" : "bridge", canBrowser ? "bridge" : "browser"].map((which) =>
              which === "browser" ? (
                <button
                  key="browser"
                  onClick={canBrowser ? () => setStage("browser") : undefined}
                  disabled={!canBrowser}
                  className={`w-full text-left rounded-lg border p-3 transition ${
                    canBrowser
                      ? "border-line dark:border-slate-600 hover:border-accent hover:bg-accent/5"
                      : "border-line dark:border-slate-700 opacity-60 cursor-not-allowed"
                  }`}
                >
                  <span className="block text-sm font-semibold text-content dark:text-mortar-100">
                    Connect through this browser
                  </span>
                  <span className="block text-xs text-muted dark:text-slate-400 mt-0.5">
                    {canBrowser
                      ? "Quickest, nothing to install. Your browser asks which printer to use."
                      : "This browser cannot reach a label printer directly. Nothing you can change here."}
                  </span>
                </button>
              ) : (
                <button
                  key="bridge"
                  onClick={() => setStage("bridge")}
                  className="w-full text-left rounded-lg border border-line dark:border-slate-600 hover:border-accent hover:bg-accent/5 p-3 transition"
                >
                  <span className="block text-sm font-semibold text-content dark:text-mortar-100">
                    Connect through an edge bridge
                  </span>
                  <span className="block text-xs text-muted dark:text-slate-400 mt-0.5">
                    A small app for your computer that talks to the printer for you. Reaches printers a
                    browser cannot, keeps printing when the tab is closed, and works from your phone.
                  </span>
                  <span className="inline-block mt-1.5 text-[11px] rounded-full border border-accent/60 text-accent px-2 py-px">
                    {scanning ? "Looking…" : found.length ? "Already running on this computer" : "Not installed yet"}
                  </span>
                </button>
              ),
            )}
          </>
        )}

        {stage === "browser" && (
          <>
            <p className="text-sm text-muted dark:text-slate-400">
              Your browser will ask which printer to use. Pick yours from its list.
            </p>
            <button
              onClick={() => void searchBluetooth()}
              disabled={busy}
              className="w-full rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-2 text-sm font-medium transition disabled:opacity-60"
            >
              {busy ? "Searching…" : "Search for my printer"}
            </button>
            {isWebSerialAvailable() && (
              <button onClick={() => setStage("not-found")} className="w-full text-xs text-muted hover:text-accent hover:underline">
                Not in the list? Look again
              </button>
            )}
            <button onClick={backTo("home")} className="w-full text-xs text-muted hover:text-accent hover:underline">
              Back
            </button>
          </>
        )}

        {stage === "bridge" && (
          <>
            {scanning && <p className="text-sm text-muted dark:text-slate-400">Looking for printers…</p>}
            {!scanning && found.length === 0 && (
              <>
                <p className="text-sm text-muted dark:text-slate-400">
                  No edge bridge is running on this computer yet. It is one command, and it needs no
                  account, token, or pairing — it only talks to this browser, on this machine.
                </p>
                <ol className="text-xs text-muted dark:text-slate-400 list-decimal ml-4 space-y-1.5">
                  <li>
                    Make sure your printer is paired in your computer&apos;s Bluetooth settings, and note its
                    address (it looks like <code>0f-38-1b-c8-41-e7</code>).
                  </li>
                  <li>
                    Run the bridge, telling it about that printer:
                    <pre className="mt-1 p-2 rounded bg-mortar-100 dark:bg-slate-800 text-[11px] overflow-x-auto whitespace-pre">{INSTALL_CMD}</pre>
                    <button
                      onClick={() => void navigator.clipboard?.writeText(INSTALL_CMD)}
                      className="mt-1 text-accent hover:underline"
                    >
                      Copy command
                    </button>
                  </li>
                  <li>Come back here and press <strong>Look again</strong>. Your printer appears by name.</li>
                </ol>
                <button
                  onClick={() => { setScanning(true); void discoverLocalPrinters().then(setFound).finally(() => setScanning(false)); }}
                  className="w-full rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-2 text-sm font-medium transition"
                >
                  Look again
                </button>
                <p className="text-xs text-muted dark:text-slate-400">
                  Running one somewhere else already, like a Pi in a workshop? That one pairs to your workspace
                  instead — add its printer from Configuration &rarr; Printers, choosing <strong>Via edge bridge</strong>.
                </p>
              </>
            )}
            {!scanning && found.length > 0 && (
              <>
                <div className="text-[11px] uppercase tracking-wide text-muted dark:text-slate-400">On this computer</div>
                {found.map((p) => (
                  <div
                    key={p.instance}
                    className="flex items-center gap-3 rounded-lg border border-line dark:border-slate-600 p-2.5"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-content dark:text-mortar-100 truncate">{printerDisplayName(p.name)}</div>
                      <div className="text-xs text-muted dark:text-slate-400">on the bridge as {p.instance}</div>
                    </div>
                    <button
                      onClick={() => void addFromBridge(p)}
                      disabled={busy}
                      className="rounded border border-accent text-accent hover:bg-accent hover:text-white px-3 py-1 text-xs font-medium transition disabled:opacity-60"
                    >
                      Add
                    </button>
                  </div>
                ))}
              </>
            )}
            <button onClick={backTo("home")} className="w-full text-xs text-muted hover:text-accent hover:underline">
              Back
            </button>
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
                If it appears more than once, try each one. Be aware that some printers
                will not connect through a browser at all, whichever entry you pick.
              </li>
            </ol>
            <button
              onClick={() => void searchPaired()}
              disabled={busy}
              className="w-full rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-2 text-sm font-medium transition disabled:opacity-60"
            >
              {busy ? "Connecting…" : "Find my paired printer"}
            </button>
            <button onClick={backTo("browser")} className="w-full text-xs text-muted hover:text-accent hover:underline">
              Back
            </button>
          </>
        )}

        {error && (
          <div className="rounded border border-ember-300 dark:border-ember-800/60 bg-ember-50 dark:bg-ember-900/20 p-3 text-xs text-content dark:text-mortar-200">
            {error}
          </div>
        )}

        {offerBridge && (
          <button
            onClick={() => { setError(null); setOfferBridge(false); setStage("bridge"); }}
            className="w-full rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-2 text-sm font-medium transition"
          >
            Connect through an edge bridge instead
          </button>
        )}
      </div>
    </Modal>
  );
}
