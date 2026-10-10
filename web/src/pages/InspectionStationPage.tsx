import { InspectionStation, BuildsApi } from "@cobblr/builds/ui";
import { useParams } from "react-router-dom";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { getToken } from "../lib/api";
import { SkipToContent } from "../components/a11y/shell-landmarks";
export function InspectionStationPage() {
 const { activeSlug: slug } = useActiveOrg(), { machineId = "", orderId = "" } = useParams();
 return <div className="min-h-screen bg-surface text-content"><SkipToContent /><InspectionStation key={`${slug}:${machineId}:${orderId}`} slug={slug} machineId={machineId} orderId={orderId} api={new BuildsApi(slug, getToken)} /></div>;
}
