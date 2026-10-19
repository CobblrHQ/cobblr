import type { OfferDecision, OfferIntake } from "@cobblr/platform-contract/share-offer";

// ── Scan-URL resolvers ──────────────────────────────────────────────────
// A scanned QR is often a URL on a maker's site that encodes a SPECIFIC
// product (a Polar Filament spool → `3dqr.co/?i=<serial>`). Treated as a
// barcode it triggers the generic web-search path, which finds the maker's
// *marketing* page, not the product. So the platform exposes a registry via
// platform().scan.registerUrlResolver, and the scan pipeline asks
// platform().scan.resolveUrl(value). In practice the registered resolver is the
// DECLARATIVE vendor resolver, which consults a data manifest LIST (built-in +
// operator-added) — adding a maker is a data entry, not a code module. The
// kernel/core-scan never imports a vendor — the same modular seam as
// registerComputedContext / registerHandler.

export interface ScanUrlResolution {
  /** Provenance for the inbox row + cache, e.g. "polar-3dqr". */
  source: string;
  /** Product name, e.g. "Royal Blue PLA". */
  name: string;
  brand: string | null;
  /** Domain category, e.g. "filament" — routes the inbox item on commit. */
  category: string | null;
  /** Entity kind to create: "part" | "asset" | … */
  entityType: string | null;
  /** Custom fields seeded onto the created entity's metadata (e.g. a filament
   *  spool's size / batch_code). Unknown keys ride along harmlessly. */
  fields: Record<string, unknown>;
  imageUrl?: string | null;
}

export interface ScanUrlResolver {
  /** Stable id for de-dup + provenance, e.g. "polar-3dqr". */
  name: string;
  /** Cheap + synchronous: does this resolver claim the scanned value? */
  matches: (value: string) => boolean;
  /** Fetch + parse the value into a product, or null on any miss / parse
   *  failure (the caller then falls back to its generic barcode path).
   *  `opts.force` = a user-initiated re-run: bypass any resolver-side cache so
   *  the value is re-fetched + re-mapped fresh (otherwise a stale cached
   *  resolution survives the re-run). */
  resolve: (value: string, opts?: { force?: boolean }) => Promise<ScanUrlResolution | null>;
}

export interface PlatformScan {
  /** Register a vendor scan-URL resolver. Called from a connector module's
   *  api/index.ts at module-load. Idempotent per `name`. */
  registerUrlResolver(resolver: ScanUrlResolver): void;
  /** Resolve a scanned value through the registered vendor resolvers, in
   *  registration order. Returns the first hit, or null if none claim it.
   *  `opts.force` rides through to each resolver (re-run bypasses caches). */
  resolveUrl(value: string, opts?: { force?: boolean }): Promise<ScanUrlResolution | null>;
  /** The scan inbox's side of a share's hand-over (share-offer.ts). The
   *  module that owns the inbox registers it at load. */
  registerOfferIntake(intake: OfferIntake): void;
  offerIntake(): OfferIntake | null;
}

/** Shares between workspaces (docs/design-decisions/share-spaces.md): what a
 *  module may ask of them. */
export interface PlatformShares {
  recordOwnSendFiling?(orgId: string, offerId: string, inboxId: string, record: { kind: string; id: string }): Promise<void>;
  /** A person answered an offer that arrived in their scan inbox. Taking it
   *  keeps it (or, in a share space, moves it to `into`, a workspace of theirs
   *  on this Cobblr); passing removes it; maybe leaves it for later. The giver
   *  is told. */
  decideOffer(
    orgId: string,
    inboxId: string,
    decision: OfferDecision,
    opts: { userId: string; into?: string | null },
  ): Promise<{ ok: true; landed?: { orgId: string; inboxId: string } } | { ok: false; error: string }>;
  /** Offer things from this workspace's scan inbox to the person a share
   *  links it with (a share space offering back to its sharer). */
  offerInboxItems(orgId: string, inboxIds: string[], opts: { userId: string }): Promise<{ ok: true; offered: number } | { ok: false; error: string }>;
}
