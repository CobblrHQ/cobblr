import { Suspense, lazy, useEffect, useState } from "react";
import { clearPersonalDocument, subscribePersonalDocument, type RaisedPersonalDocument } from "@cobblr/platform-web";
import { useActiveOrg } from "../auth/ActiveOrgContext";

const PersonalDocumentSheetBody = lazy(() => import("./PersonalDocumentSheetBody"));

/** Listens in the app shell for a personal document an upload raised; the
 *  card itself loads only then (the dashboard's first-load budget). */
export function PersonalDocumentSheet() {
  const { activeSlug } = useActiveOrg();
  const [document, setDocument] = useState<RaisedPersonalDocument | null>(null);
  useEffect(() => subscribePersonalDocument((value) => {
    if (value && value.orgSlug !== activeSlug) { clearPersonalDocument(); return; }
    setDocument(value);
  }), [activeSlug]);
  if (!document) return null;
  return <Suspense fallback={null}><PersonalDocumentSheetBody document={document} /></Suspense>;
}
