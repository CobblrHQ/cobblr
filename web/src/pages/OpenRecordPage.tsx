// The open door: a link that knows only a record's kind and id comes here, the
// server says where the record lives (its own collection decides), and the
// page goes there, replacing itself in history so Back returns to where the
// link was. A surface that cannot know the collection (a tag's attachment
// row, a calendar entry, a notification written before the item moved) still
// opens the record instead of the base route's "part not found" (#3623).
import { useEffect } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

export function OpenRecordPage() {
  const { kind = "", id = "" } = useParams();
  const { activeSlug } = useActiveOrg();
  const navigate = useNavigate();
  const address = useQuery({
    queryKey: ["record-address", activeSlug, kind, id],
    queryFn: () => api.recordAddress(activeSlug, kind, id),
    enabled: !!activeSlug && !!kind && !!id,
    retry: false,
  });
  const path = address.data?.path;
  useEffect(() => {
    if (path) navigate(path, { replace: true });
  }, [path, navigate]);

  if (address.error) {
    const words = address.error instanceof ApiError ? address.error.message : "That record could not be opened.";
    return (
      <div className="max-w-md mx-auto mt-16 text-center space-y-3" data-testid="open-record-missing">
        <p className="text-sm text-content dark:text-mortar-100">{words}</p>
        <Link to="/" className="text-sm text-accent hover:underline">
          Back to the dashboard
        </Link>
      </div>
    );
  }
  return <div className="mt-16 text-center text-sm text-muted dark:text-slate-400">Opening…</div>;
}
