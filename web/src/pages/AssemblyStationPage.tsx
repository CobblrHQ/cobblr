import { AssemblyStation, BuildsApi } from "@cobblr/builds/ui";
import { useParams } from "react-router-dom";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { getToken } from "../lib/api";
import { ScanOneSheet } from "../components/ScanOneSheet";
import { SkipToContent } from "../components/a11y/shell-landmarks";
export function AssemblyStationPage() {
  const { activeSlug: slug } = useActiveOrg();
  const { machineId = "", orderId = "" } = useParams();
  return <div className="min-h-screen bg-surface text-content"><SkipToContent /><AssemblyStation key={`${slug}:${machineId}:${orderId}`} slug={slug} machineId={machineId} orderId={orderId} api={new BuildsApi(slug, getToken)} camera={(onCode, onClose) => <ScanOneSheet open title="Scan loaded reel" onCode={onCode} onClose={onClose} />} /></div>;
}
