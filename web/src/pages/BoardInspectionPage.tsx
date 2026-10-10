import { BoardInspection, BuildsApi } from "@cobblr/builds/ui";
import { useParams } from "react-router-dom";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { getToken } from "../lib/api";
import { queueLabel } from "../lib/queue-label";
export function BoardInspectionPage() {
 const { activeSlug: slug } = useActiveOrg(), { id = "" } = useParams();
 return <BoardInspection slug={slug} id={id} api={new BuildsApi(slug, getToken)} queueLabel={(entityId, description) => queueLabel({ slug, entityKind: "builds:inspection", entityId, description })} />;
}
