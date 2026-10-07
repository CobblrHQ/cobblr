import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { QueryError, usePageTitle } from "@cobblr/platform-web";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { api } from "../lib/api";
import { KilnRecords } from "../features/digifab/kiln";
import { MAIN_ID, SkipToContent } from "../components/a11y/shell-landmarks";
export function KilnStationPage() {
 const { activeSlug: slug } = useActiveOrg(), { machineId = "" } = useParams();
 usePageTitle("Kiln station");
 const query = useQuery({ queryKey: ["kiln-machine", slug, machineId], queryFn: () => api.lookupEntity(slug, "machines:machine", machineId) });
 return <div className="min-h-screen bg-surface text-content"><SkipToContent /><main id={MAIN_ID} className="mx-auto max-w-3xl p-4 sm:p-6 space-y-4"><header className="flex flex-wrap gap-3 items-center"><h1 className="flex-1 text-2xl font-semibold">{query.data?.title || "Kiln station"}</h1><Link className="min-h-11 rounded border border-line px-3 py-2" to={`/w/${slug}/machines`}>Back to machines</Link></header>{query.isError && <QueryError what="The kiln could not be loaded." onRetry={() => void query.refetch()} />}{query.data && <KilnRecords station ctx={{ slug, entityId: machineId, entityTitle: query.data.title }} />}</main></div>;
}
