import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { OnceQuiet, QueryError, usePageTitle, WorkspaceLink } from "@cobblr/platform-web";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { api } from "../lib/api";
import { ArmRecords } from "../features/digifab/robotArm";
import { MAIN_ID, SkipToContent } from "../components/a11y/shell-landmarks";
export function ArmStationPage() {
 const { activeSlug: slug } = useActiveOrg(), { machineId = "" } = useParams();
 usePageTitle("Arm station");
 const query = useQuery({ queryKey: ["arm-machine", slug, machineId], queryFn: () => api.lookupEntity(slug, "machines:machine", machineId) });
 return <div className="min-h-screen bg-surface text-content"><SkipToContent /><main id={MAIN_ID} className="mx-auto max-w-3xl p-4 sm:p-6 space-y-4"><header className="space-y-3"><WorkspaceLink className="inline-flex min-h-11 items-center rounded border border-line px-3 py-2" slug={slug} to={`/machines`}>Back to machines</WorkspaceLink><h1 className="text-2xl font-semibold">{query.data?.title || "Arm station"}</h1></header>{query.isError && <QueryError what="The arm could not be loaded." onRetry={() => void query.refetch()} />}{query.data && <OnceQuiet><ArmRecords station ctx={{ slug, entityId: machineId, entityTitle: query.data.title }} /></OnceQuiet>}</main></div>;
}
