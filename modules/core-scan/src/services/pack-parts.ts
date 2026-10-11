import { LABELS_OUTPUT_SCHEMA } from "@cobblr/platform-contract/ai-output-schemas";
// A pack becomes its parts, read on the store's own page (#5719). The owner,
// on a Kingroon order of three 10 kg PETG packs: "What I would love is if it
// actually navigates to the product page and figures out the individual 10
// filament spools that each line contains."
//
// The receipt line's first pass. With the store's product read
// (store-product.ts):
// - the line's variant photo is its picture, when the email printed none;
// - a pack of N in a mixed colour ("10KG / Multicolor") is split into one
//   row per colour, each named and pictured as the store sells that colour
//   on its own, so each is matched on its own: a white spool already held
//   gets one more only from the pack that holds white.
// The store's colour names are the only answers a read of the pack's photo
// may give; it runs only when the page lists no contents, and a pack it
// cannot read stays one line of N, saying why. Never "+1".

import type { Kysely } from "kysely";
import { countOf, platform } from "@cobblr/platform-contract";
import {
  colourOptionAt,
  isMixedColour,
  packColoursRead,
  singleColours,
  variantInColour,
  variantPhoto,
  type StoreProduct,
  type StoreVariant,
} from "@cobblr/platform-contract/store-product";
import type { CoreScanDB } from "../db.js";
import { mergeMeta } from "./metadata.js";
import { splitRowIntoParts, type PartsRow, type RowPart } from "./row-parts.js";
import { knownPackFor, packOptionsOf, type KnownPack } from "@cobblr/platform-contract/known-packs";
import { askPackNetwork, type PackKey } from "./pack-network.js";
import type { BoxChoice } from "@cobblr/platform-contract/box-label";
import { readStoreProduct, type StoreFetch } from "./store-product.js";
import { fetchImageBase64 } from "./rank-photo.js";
import { splitOrderLineForParts, type PurchaseHttp } from "./receipt-purchase.js";


/** One colour per item, null for a spool the read could not name. */
export type PackColourRead = (o: { orgId: string; itemId: string; userId: string | null; photo: string; title: string; count: number; choices: string[] }) => Promise<Array<string | null> | { unread: string }>;

export interface StoreProductPassOpts {
  db: Kysely<CoreScanDB>;
  orgId: string;
  itemId: string;
  userId: string | null;
  /** Makes each part's row (intakeRow with the receipt door). */
  admit: (values: Record<string, unknown>) => Promise<{ id: string }>;
  fetch?: StoreFetch;
  readColours?: PackColourRead;
  /** Ask the barcode network what a pack holds (pack-network.ts); tests pass their own. */
  askNetwork?: typeof askPackNetwork;
  /** The seeded packs (KNOWN_PACKS); the learning-loop bench passes none. */
  seed?: readonly KnownPack[];
  /** The purchase's door, so a split pack splits its order line too
   *  (splitOrderLineForParts); absent with no session, and the order's own
   *  stamp does it when it lands. */
  purchase?: PurchaseHttp | null;
  splitOrderLine?: typeof splitOrderLineForParts;
}

export type StoreProductOutcome = "skipped" | "unread" | "read" | "split" | "pack-unread";

export async function storeProductPass(o: StoreProductPassOpts): Promise<StoreProductOutcome> {
  const row = await o.db.selectFrom("core_scan_inbox_items").selectAll().where("id", "=", o.itemId).executeTakeFirst();
  if (!row || row.source_kind !== "receipt" || row.status !== "pending") return "skipped";
  const meta = (row.suggested_metadata ?? {}) as Record<string, unknown>;
  const host = typeof meta.store_host === "string" ? meta.store_host : null;
  if (!host || meta.split_from || meta.store_product) return "skipped";
  const line = (typeof meta.description === "string" && meta.description) || row.suggested_name || "";
  const read = await readStoreProduct({ orgId: o.orgId, host, line, ...(o.fetch ? { fetch: o.fetch } : {}) });
  const pack = meta.line_pack as { count?: number; each?: string | null; ask?: boolean } | undefined;
  const count = !pack?.ask && typeof pack?.count === "number" ? pack.count : 0;
  if ("unread" in read) {
    await stamp(o.db, o.itemId, {
      store_product: { status: "unread", host, why: read.unread },
      ...(count > 1 && /multi|mix|assort/i.test(line) ? { pack_parts: { status: "unread", why: read.unread } } : {}),
    });
    return "unread";
  }
  const photo = variantPhoto(read.variant);
  await stamp(o.db, o.itemId, {
    store_product: { status: "read", host, url: read.url, variant: read.variant.title, ...(photo ? { photo } : {}) },
    // The email's own picture outranks the store's; the store's outranks a search.
    ...(photo && !meta.order_line_image ? { store_line_image: photo } : {}),
  });
  const at = colourOptionAt(read.product);
  const colour = at >= 0 ? [read.variant.option1, read.variant.option2, read.variant.option3][at] : null;
  if (count <= 1 || !isMixedColour(colour)) return "read";
  // A pack someone has confirmed (its boxes read, #5764) splits into its
  // known contents with no model; only an unknown pack's photo is read.
  // Then what people confirmed on the barcode network (#3769).
  const key = { host: host.toLowerCase().replace(/^www\./, ""), title: read.product.title, options: packOptionsOf(read.product, read.variant) };
  const seeded = knownPackFor(host, read.product.title, key.options, o.seed);
  const learned = seeded ? null : await (o.askNetwork ?? askPackNetwork)(key);
  const known = seeded
    ? { units: seeded.units, source: seeded.source }
    : learned
      ? { units: learned.units, source: learned.confidence === "confident" ? "confirmed by people on the barcode network" : "named by one person on the barcode network" }
      : null;
  if (known && known.units.length === count) {
    await splitIntoColours(o, row, meta, read.product, read.variant, known.units.map((u) => u.colour), pack!, known, key);
    if (o.purchase) await (o.splitOrderLine ?? splitOrderLineForParts)(o.db, o.itemId, o.purchase).catch((e: Error) => console.warn("[core-scan] pack order line split:", e.message));
    return "split";
  }
  const choices = singleColours(read.product);
  const colours = photo && choices.length
    ? await (o.readColours ?? readPackColours)({ orgId: o.orgId, itemId: o.itemId, userId: o.userId, photo, title: `${read.product.title} - ${read.variant.title}`, count, choices })
    : { unread: "the store's page lists no single colours to name them by" };
  if (!Array.isArray(colours)) {
    await stamp(o.db, o.itemId, { pack_parts: { status: "unread", why: colours.unread } });
    return "pack-unread";
  }
  await splitIntoColours(o, row, meta, read.product, read.variant, colours, pack!, undefined, key);
  if (o.purchase) await (o.splitOrderLine ?? splitOrderLineForParts)(o.db, o.itemId, o.purchase).catch((e: Error) => console.warn("[core-scan] pack order line split:", e.message));
  return "split";
}

async function stamp(db: Kysely<CoreScanDB>, id: string, patch: Record<string, unknown>): Promise<void> {
  await db
    .updateTable("core_scan_inbox_items")
    .set({ suggested_metadata: mergeMeta(patch) as never, updated_at: new Date() })
    .where("id", "=", id)
    .execute();
}

/** Each colour once, with how many of it, in the order the read named them;
 *  the spools it could not name together, as null. */
function tally(colours: ReadonlyArray<string | null>): Array<{ colour: string | null; n: number }> {
  const out: Array<{ colour: string | null; n: number }> = [];
  for (const c of colours) {
    // A spool of unknown colour is a row of its own: two unknowns are not
    // known to be the same (#5764).
    const hit = c === null ? undefined : out.find((x) => x.colour === c);
    if (hit) hit.n += 1;
    else out.push({ colour: c, n: 1 });
  }
  return out;
}

async function splitIntoColours(
  o: StoreProductPassOpts,
  row: PartsRow,
  meta: Record<string, unknown>,
  product: StoreProduct,
  variant: StoreVariant,
  colours: Array<string | null>,
  pack: { count?: number; each?: string | null },
  known?: { units: readonly BoxChoice[]; source: string },
  key?: PackKey,
): Promise<void> {
  const groups = tally(colours);
  const unitOf = (colour: string | null) => (colour ? known?.units.find((u) => u.colour === colour) ?? null : null);
  const parts: RowPart[] = groups.map(({ colour, n }) => {
    // A spool the read could not name is kept, as the pack's product with its
    // colour to fill in, and the pack's own photo; it is an ordinary row a
    // person corrects on the card.
    const alone = colour ? variantInColour(product, variant, colour) : null;
    const name = colour ? (alone ? `${product.title} - ${alone.title}` : `${product.title} ${colour}`) : `${product.title}, colour unknown`;
    const photo = colour ? variantPhoto(alone) : variantPhoto(variant);
    return {
      name,
      n,
      meta: {
        pack_colour: colour,
        // What its box prints, from the pack's known contents: the colour as
        // the box says it and the SKU, the part number a scan of it confirms.
        ...(unitOf(colour) ? { pack_unit: { label_colour: unitOf(colour)!.label_colour ?? null, sku: unitOf(colour)!.sku ?? null, source: known!.source } } : {}),
        line_pack: { ask: false, count: n, each: pack.each ?? null, whole: null, ...(colour ? { colour } : {}) },
        store_product: { status: "read", host: meta.store_host, url: null, variant: alone?.title ?? colour ?? null, pack_of: variant.title, ...(photo ? { photo } : {}), ...(colour ? {} : { colour_unread: true }) },
        ...(photo ? { store_line_image: photo } : {}),
      },
    };
  });
  await splitRowIntoParts(o, row, meta, parts, {
    note: `Split into ${colours.length} by colour, ${known ? "from what this pack is known to hold" : "from the store's page"}: ${groups.map((t) => `${t.n > 1 ? `${t.n} ` : ""}${t.colour ?? "colour unknown"}`).join(", ")}.`,
    // The pack's key goes with the line, so its contents can be reported
    // once every part is filed (pack-network.ts).
    mark: { pack_split: true, line_units: { mode: "different", by: "evidence" }, ...(key ? { pack_key: key } : {}) },
  });
}

/** Which of the store's colours the pack's photo shows, one per item. A
 *  model is asked only here, where the page lists no contents, and only to
 *  choose among the store's own colour names; an answer that names a colour
 *  the store does not sell, or misses an item, is no answer. */
export const readPackColours: PackColourRead = async (o) => {
  const img = await fetchImageBase64(o.photo);
  if (!img) return { unread: "the pack's photo could not be fetched" };
  let text = "";
  try {
    const r = await platform().ai.invoke({
      orgId: o.orgId,
      capability: "classify-image",
      input: { output_schema: LABELS_OUTPUT_SCHEMA,
        prompt:
          `This is the store's own photo of the pack "${o.title}", which holds ${countOf(o.count, "item")} in different colours. ` +
          `Give one label per item shown, left to right and top to bottom, so the list has exactly ${countOf(o.count, { singular: "entry", plural: "entries" })}; repeat a label when two items share a colour. ` +
          `Give each its own confidence, low when you are unsure of that one item.`,
        labels: o.choices,
        image_b64: img.b64,
        image_media_type: img.mediaType,
      },
      source: { kind: "core-scan:pack-colours", id: o.itemId },
      ...(o.userId ? { userId: o.userId } : {}),
    });
    text = r.text;
  } catch (e) {
    return { unread: `no model could read the pack's photo (${(e as Error).message.slice(0, 80)})` };
  }
  const read = packColoursRead(labelsOf(text), o.choices, o.count);
  return read ?? { unread: "the pack's photo named none of the store's colours" };
};

/** The labels a classify-image reply names, in order, repeats kept, each
 *  with its confidence when the reply gave one. */
export function labelsOf(text: string): Array<{ label: string; confidence: number | null }> {
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as { labels?: Array<{ label?: unknown; confidence?: unknown } | string> };
    return (parsed.labels ?? [])
      .map((l) =>
        typeof l === "string"
          ? { label: l, confidence: null }
          : { label: typeof l?.label === "string" ? l.label : "", confidence: typeof l?.confidence === "number" ? l.confidence : null },
      )
      .filter((l) => l.label);
  } catch {
    return [];
  }
}
