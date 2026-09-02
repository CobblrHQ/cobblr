// "Scan your first thing" — the one move that explains the whole product, put
// in front of somebody who has not made it yet.
//
// A sandbox arrives pre-stocked so it does not look like an empty spreadsheet.
// The cost of that is the new-user flow never fires: the app sees a workspace
// with content and behaves as though the visitor filled it, folding away the
// panel that says what to do. So the one thing worth doing gets no billing at
// all, and "point your phone at a barcode and the details appear" stays a claim
// on the marketing site.
//
// On a DESKTOP this is two steps, because a laptop has no camera worth scanning
// with: pair the phone, then point it at the barcode printed right here. The
// code is a real product (verified to resolve), so the payoff is a real name
// and a real photo rather than an "unknown item" shrug.
//
// On a PHONE the same idea cannot work, because the barcode would be on the
// screen doing the scanning. There the nudge is just: open the scanner and
// point it at anything within reach.
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useConfirm, useToast } from "@cobblr/platform-web";
import { api } from "../lib/api";
import { ScanLine } from "lucide-react";
import { Link } from "react-router-dom";
import { Ean13 } from "./Ean13";
import { PairPhoneButton } from "./PairPhoneButton";
import { isTouchPrimary } from "../lib/useIsTouch";
import { DEMO_BARCODE } from "../lib/demo-barcode";


export function FirstScanCard() {
  const [touch] = useState(isTouchPrimary);
  const [emptying, setEmptying] = useState(false);
  const confirm = useConfirm();
  const toast = useToast();
  const qc = useQueryClient();

  async function empty() {
    const ok = await confirm({
      title: "Empty this workspace?",
      message: "The books and food we put here get deleted. Your modules, fields and saved views stay, so you can start filling it with your own things.",
      confirmLabel: "Empty it",
      destructive: true,
    });
    if (!ok) return;
    setEmptying(true);
    try {
      const r = await api.emptySandbox();
      await qc.invalidateQueries();
      // No count: this spans every kind in the workspace, so there is no single
      // noun it could be counted in, and "records" is the DB's word not theirs.
      toast.success(
        r.failed > 0
          ? "Emptied what it could. A few things would not delete."
          : "Emptied. Your modules, fields and views are untouched.",
      );
    } catch {
      toast.error("Could not empty it. Try again?");
    } finally {
      setEmptying(false);
    }
  }
  return (
    <div className="rounded-lg border border-cobble-300 dark:border-cobble-700 bg-cobble-50/70 dark:bg-cobble-900/25 p-3 sm:p-4">
      <p className="flex items-center gap-2 font-medium text-sm text-content dark:text-mortar-100">
        <ScanLine size={16} className="text-accent shrink-0" />
        Scan your first thing
      </p>
      {touch ? (
        <>
          <p className="text-sm text-muted mt-1">
            Open the scanner and point it at any barcode near you: a tin, a book, a bottle.
            The name, photo and details come back filled in.
          </p>
          <Link
            to="/scan/camera"
            className="inline-flex items-center gap-2 mt-2.5 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white font-medium px-3 py-1.5 text-sm transition"
          >
            <ScanLine size={15} /> Open the scanner
          </Link>
        </>
      ) : (
        <div className="mt-2 grid gap-3 sm:grid-cols-[auto_1fr] sm:items-center">
          <div className="rounded-md border border-line dark:border-slate-700 bg-white p-2 w-fit">
            <Ean13 code={DEMO_BARCODE} height={54} />
          </div>
          <ol className="text-sm text-muted space-y-1.5 list-decimal list-inside">
            {/* The button carries its own icon and the words "Pair phone", so
                the step must not say them again. */}
            <li className="marker:text-faint">
              <PairPhoneButton className="inline-flex items-center gap-1.5 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white px-2.5 py-1 text-sm font-medium transition align-middle" />{" "}
              so its camera scans into this workspace.
            </li>
            <li className="marker:text-faint">Point its camera at the barcode on the left.</li>
            <li className="marker:text-faint">
              Watch it arrive in your scan inbox, named, with its photo.
            </li>
          </ol>
        </div>
      )}
      {/* The alternative to asking "stocked or blank?" at the door, which makes
          somebody choose before either word means anything. Offered here, after
          they have seen what the stocked version looks like. */}
      <p className="text-xs text-muted mt-3 pt-2.5 border-t border-line/60 dark:border-slate-700/60">
        Seen enough?{" "}
        <button
          type="button"
          onClick={empty}
          disabled={emptying}
          className="text-accent hover:underline disabled:opacity-50"
        >
          {emptying ? "Emptying…" : "Empty this workspace"}
        </button>{" "}
        and set it up your own way. Your modules and views stay.
      </p>
    </div>
  );
}
