// The one line every address field shows when the address it holds is on the
// person's own network and this Cobblr cannot reach it without a bridge.
//
// Before this, only two forms noticed, each with its own copy of the rule, and
// Part-DB, Homebox, a sync connection and a print manager said nothing until
// the connection failed with a raw "fetch failed" (#3904). The rule is the
// contract's (`needsBridge`), the same one the hosted egress guard applies.

import { Link } from "react-router-dom";
import { Router } from "lucide-react";
import { addressReach, needsBridge } from "@cobblr/platform-contract/address-reach";

/**
 * `throughBridge`: the form already sends this address through a bridge (the
 * person ticked it, or the form picked it for them), so the line confirms
 * rather than warns. Without it, the line says what to do next.
 */
export function HomeNetworkHint({
  address,
  hosted,
  throughBridge = false,
}: {
  address: string;
  hosted: boolean;
  throughBridge?: boolean;
}) {
  if (!needsBridge(address, { hosted })) return null;
  const r = addressReach(address);
  const where = r.kind === "home" ? r.host : address;
  return (
    <p
      data-testid="home-network-hint"
      className={
        "flex items-start gap-1.5 text-[11px] " +
        (throughBridge ? "text-muted dark:text-slate-400" : "text-amber-700 dark:text-amber-400")
      }
    >
      <Router size={12} className="mt-0.5 shrink-0" />
      {throughBridge ? (
        <span>
          <span className="font-mono">{where}</span> is on your home network, so Cobblr reaches it through your bridge.
        </span>
      ) : (
        <span>
          <span className="font-mono">{where}</span> is on your home network, so Cobblr can't reach it by itself. A small
          bridge on that network carries it.{" "}
          <Link to="/configuration/devices" className="underline hover:text-accent">
            Set up a bridge
          </Link>
        </span>
      )}
    </p>
  );
}
