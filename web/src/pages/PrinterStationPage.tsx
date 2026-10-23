import { productName } from "@cobblr/platform-web";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { QueryError, usePageTitle, WorkspaceLink } from "@cobblr/platform-web";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { api } from "../lib/api";
import { LoadedSpoolsPanel } from "../features/digifab/loaded";
import { MachinePrintBatches } from "../features/digifab/PrintBatchCard";
import { GlobalScanWedge } from "../components/GlobalScanWedge";
import { MAIN_ID, SkipToContent } from "../components/a11y/shell-landmarks";

export function PrinterStationPage() {
  const { activeSlug: slug } = useActiveOrg();
  const { machineId = "" } = useParams();
  usePageTitle("Printer station");
  const query = useQuery({ queryKey: ["printer-station", slug, machineId], queryFn: () => api.lookupEntity(slug, "machines:machine", machineId) });
  return <div className="min-h-screen bg-surface text-content">
    <SkipToContent /><GlobalScanWedge activeSlug={slug} />
    <main id={MAIN_ID} className="mx-auto max-w-3xl p-4 sm:p-6 space-y-4">
      <header className="space-y-3"><WorkspaceLink className="inline-flex min-h-11 items-center rounded border border-line px-3 py-2" slug={slug} to={`/digifab`}>Back to machines</WorkspaceLink><h1 className="text-2xl font-semibold">{query.data?.title || "Printer station"}</h1></header>
      <p>Scan the spool you are loading. {productName()} saves the swap and sends the previous spool back to its shelf.</p>
      {query.isError && <QueryError what="The record could not be loaded." onRetry={() => void query.refetch()} />}
      {query.data && <LoadedSpoolsPanel ctx={{ slug, entityId: machineId, entityTitle: query.data.title, kind: query.data.kind, hints: { station: "printer" } }} />}
      {query.data && <MachinePrintBatches slug={slug} machineId={machineId} />}
    </main>
  </div>;
}
