// core-shipments router. Mounted at /api/v1/orgs/:slug/modules/core-shipments/.
//
// Detection is a pure function over the number, so /carrier reads nothing and
// writes nothing. /status calls the carrier, so it is the one that can be slow
// or fail, and it says which of those happened rather than collapsing both to
// an empty answer.

import { Router } from "express";
import { platform } from "@cobblr/platform-contract";
import { z } from "zod";
import { detectCarrier, knownCarriers, trackingLookup } from "../carriers.js";
import { aggregatorConfigured, aggregatorNames, driverFor, driverStatus } from "../drivers/index.js";
import { CarrierError } from "../status.js";
import { registerShipmentsActionHandlers } from "./action-handlers.js";

registerShipmentsActionHandlers(); // core-shipments.track

const router = Router({ mergeParams: true });

const NumberQuery = z.object({
  number: z.string().min(1).max(64),
});

/** Which carrier is this number, and where does a person go to look at it.
 *
 *  An unrecognised number is a 200 with `carrier: null`, not a 404: "we do not
 *  know this format" is a real answer about a real parcel, and the caller
 *  renders it as "no carrier recognised" rather than as a broken request.
 *
 *  `lookup` is ALWAYS present, including when `carrier` is null. Not naming the
 *  carrier is no reason to leave someone with a tracking number on screen and
 *  nothing to click. */
router.get("/carrier", (req, res) => {
  const parsed = NumberQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "number is required" });
    return;
  }

  const carrier = detectCarrier(parsed.data.number);
  res.json({ carrier, lookup: trackingLookup(parsed.data.number, carrier) });
});

/** Where the parcel actually is, asked of the carrier now.
 *
 *  Four outcomes, and they are deliberately distinguishable, because the one
 *  thing a caller must never do is read a failure as "not delivered yet" and
 *  act on it:
 *
 *    carrier: null                    the number belongs to nobody we know
 *    tracking: null, reason: ...      we know the carrier, we cannot follow it
 *    status: {...}                    an answer from the carrier
 *    502 + retryable                  the carrier failed to answer
 */
router.get("/status", async (req, res) => {
  const parsed = NumberQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "number is required" });
    return;
  }

  const orgId = (req as { org?: { id?: string } }).org?.id ?? "";

  try {
    // Through the ACTION, never straight to a driver. The action is where the
    // rules live -- is it even due, is it finished, how does the answer rank
    // against the estimate we had -- and a second path to the driver is a
    // second path with none of them. `lint:shipments-one-door` keeps it so.
    const out = (await platform().actions.invoke("core-shipments:track", {
      orgId,
      userId: null,
      event: {
        name: "core-shipments.status-read",
        payload: {},
        actor: { user_id: null, display_name: null, auth_method: "system" },
        timestamp: new Date().toISOString(),
        trigger_type: "user-invoked",
      },
      // A person is looking at this record right now, so it is worth asking
      // even off-cadence. `confirmed` still outranks this inside the action.
      args: { number: parsed.data.number, force: true },
    })) as {
      followed?: boolean;
      status?: unknown;
      reason?: string | null;
      retryable?: boolean;
      message?: string;
    } | null;

    const carrier = detectCarrier(parsed.data.number);
    if (out?.followed && out.status) {
      res.json({ carrier, status: out.status, reason: null });
      return;
    }

    const reason = out?.reason ?? "carrier_error";
    const code = reason === "carrier_error" ? 502 : reason === "quota_exhausted" ? 507 : 200;
    res.status(code).json({ carrier, status: null, reason, message: out?.message });
  } catch (err) {
    // Only a THROW from invoke lands here. Everything the action itself
    // decided — not connected, not due, quota exhausted — comes back as a
    // `reason` above, because the action is where those are known.
    res.status(502).json({
      carrier: detectCarrier(parsed.data.number),
      status: null,
      reason: "carrier_error",
      // A driver never puts a credential in its message; see fedex.ts.
      message: err instanceof Error ? err.message : "the carrier did not answer",
    });
  }
});

/** The carriers this build can identify, and which of them this deployment can
 *  actually follow. The UI needs both to tell "we cannot read that number"
 *  from "nobody has connected FedEx here yet". */
router.get("/carriers", (_req, res) => {
  const drivers = new Map(driverStatus().map((d) => [d.code, d.configured]));
  // An aggregator answers for carriers we have no driver of our own for, so
  // it makes every recognised carrier followable.
  const aggregator = aggregatorConfigured();
  res.json({
    aggregator,
    // Which wire formats this build can speak, so a settings screen can offer
    // them and an operator who typed an unknown one can see why nothing works.
    aggregatorFormats: aggregatorNames(),
    carriers: knownCarriers().map((c) => ({
      ...c,
      canFollow: (drivers.get(c.code) ?? false) || aggregator,
      hasDriver: drivers.has(c.code) || aggregator,
    })),
  });
});

export default router;
