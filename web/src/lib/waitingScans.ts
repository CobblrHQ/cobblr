// The host half of a collection's "waiting in your scan inbox" strip
// (platform-web InboxWaitingStrip): which waiting rows a search finds for one
// table, and filing one of them in a tap.
//
// Each row is judged the way the inbox card judges it (scanRowState over the
// person's view of the workspace, scanViewerContext), so the strip offers Add
// exactly where the card would, and files through the card's own one-tap
// door (quickFileRow). The menu, the person's grants and the module list come
// from the query cache the pages already fill.
import type { QueryClient } from "@tanstack/react-query";
import type { PlatformWaitingScan } from "@cobblr/platform-web";
import { filedIntoOf, scanRowState } from "@cobblr/platform-contract/scan-triage";
import { api, type ScanInboxItem } from "./api";
import { scanFileUrl } from "./rowPictures";
import { leadPhoto } from "./scanPhoto";
import { scanViewerContext } from "../pages/scanViewer";
import { oneTapDestination, quickFileRow } from "../pages/scanQuickFile";

async function viewerFor(qc: QueryClient, slug: string, role: string | null) {
  const [menu, caps, modules] = await Promise.all([
    qc.fetchQuery({ queryKey: ["scan-menu", slug], queryFn: () => api.scanMenu(slug), staleTime: 60_000 }),
    qc.fetchQuery({ queryKey: ["me-capabilities", slug], queryFn: () => api.getMyCapabilities(slug), staleTime: 60_000 }),
    qc.fetchQuery({ queryKey: ["org-modules", slug], queryFn: () => api.orgModules(slug), staleTime: 30_000 }),
  ]);
  return scanViewerContext({ role, caps, menu: menu.items, modules: modules.items });
}

function pictureOf(slug: string, it: ScanInboxItem): string | null {
  return leadPhoto(it, {
    catalog: [it.catalog_image_file_id ? scanFileUrl(slug, it.catalog_image_file_id, "thumb") : null],
    yours: it.image_file_id ? scanFileUrl(slug, it.image_file_id, "thumb") : null,
  }).src;
}

export async function waitingScans(
  qc: QueryClient,
  role: string | null,
  slug: string,
  q: string,
  destination: string,
): Promise<{ items: PlatformWaitingScan[]; total: number }> {
  const [found, viewer] = await Promise.all([api.listScanInbox(slug, { q, destination, limit: 12 }), viewerFor(qc, slug, role)]);
  const items = found.items.map((it): PlatformWaitingScan => {
    const state = scanRowState(it, viewer);
    const ready = !!it.suggested_name && (state.eligibility === "ready" || state.eligibility === "needs-install");
    return {
      id: it.id,
      name: it.suggested_name ?? it.barcode_text ?? "Unnamed scan",
      image: pictureOf(slug, it),
      destinationLabel: it.resolved_destination?.label ?? state.destination?.label ?? null,
      canFile: ready,
      reason: ready ? null : state.sentence,
      href: `/scan?item=${encodeURIComponent(it.id)}`,
    };
  });
  return { items, total: found.total ?? items.length };
}

export async function fileWaitingScan(
  qc: QueryClient,
  role: string | null,
  slug: string,
  id: string,
): Promise<{ label: string; record: { kind: string; id: string } | null }> {
  const [item, viewer] = await Promise.all([api.getScanItem(slug, id), viewerFor(qc, slug, role)]);
  const state = scanRowState(item, viewer);
  const dest = oneTapDestination(item, state.destination);
  if (!dest) throw new Error("This scan has nowhere to go yet; open it in the scan inbox.");
  const { filed } = await quickFileRow(slug, item, dest);
  const into = filedIntoOf(filed.item.suggested_metadata);
  return {
    label: into?.label ?? dest.label ?? state.destination?.label ?? "its table",
    record: into?.kind ? { kind: into.kind, id: filed.created.id } : null,
  };
}
