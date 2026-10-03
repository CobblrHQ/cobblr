import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { NfcTags, StationTagWriter, usePageTitle } from "@cobblr/platform-web";
import { useMemo } from "react";
import { useLabels } from "./context";

export function NfcPage() {
  usePageTitle("NFC tag");
  const { api, orgSlug } = useLabels();
  const stationClient = useMemo(() => api.stationTags(), [api]);
  const [params] = useSearchParams();
  const kind = params.get("kind") ?? "";
  const id = params.get("id") ?? "";
  const label = params.get("title") || "Record";
  const link = useQuery({
    queryKey: ["label-tag-link", orgSlug, kind, id],
    queryFn: () => api.labelUrlForEntity({ entity_kind: kind, entity_id: id }),
    enabled: !!kind && !!id,
    retry: false,
  });
  return <div className="max-w-lg space-y-4">
    <h1 className="font-display text-2xl font-extrabold page-title">NFC tag</h1>
    {!kind || !id ? <p role="alert">Choose NFC tag beside a record’s label button.</p>
      : link.isError ? <p role="alert">Could not get the tag link. {link.error.message}</p>
        : link.data ? <><NfcTags key={`${kind}:${id}`} targets={[{ title: label, url: link.data }]} /><StationTagWriter client={stationClient} workspace={orgSlug} url={link.data} /></>
          : <p role="status">Getting the tag link…</p>}
  </div>;
}
