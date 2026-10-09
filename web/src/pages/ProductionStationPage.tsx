import { useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { usePageTitle } from "@cobblr/platform-web";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { MAIN_ID, SkipToContent } from "../components/a11y/shell-landmarks";
import { ProductionStation, type ProductionStationPort, type StationAttempt } from "../features/production-test/Station";
import { useProductionAction } from "../features/production-test/use-production-action";
export function ProductionStationPage() {
 usePageTitle("Production test station");
 const { connectionId = "" } = useParams(), { activeSlug } = useActiveOrg(), action = useProductionAction(), navigate = useNavigate();
 const port = useMemo<ProductionStationPort>(() => ({ read: () => action<{ attempts: StationAttempt[] }>("production-read", "bridge", { connection_id: connectionId }), act: (operation, args) => operation === "sync" ? action("production-test", "sync", args) : operation === "abort" ? action("production-abort", "abort", args) : action("production-control", operation, args) }), [activeSlug, connectionId, action]);
 return <><SkipToContent /><main id={MAIN_ID} tabIndex={-1} className="p-3 sm:p-6"><Link className="inline-flex min-h-12 items-center underline" to="/digifab/production">Plans and unit history</Link><ProductionStation key={`${activeSlug}:${connectionId}`} port={port} onResult={attempt => { navigate(`/digifab/production?run=${encodeURIComponent(attempt.id)}`); }} /></main></>;
}
