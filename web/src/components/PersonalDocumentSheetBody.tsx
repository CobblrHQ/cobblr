import { Modal, clearPersonalDocument, nextPersonalDocument, type RaisedPersonalDocument } from "@cobblr/platform-web";
import { PersonalDocumentCard } from "./PersonalDocumentReader";
import { DocumentRenewalCard } from "../features/core-maintenance/document-renewal";

/** The card a raised personal document opens. Loaded only when one is
 *  raised, so the app shell does not carry it on every first load. */
export default function PersonalDocumentSheetBody({ document }: { document: RaisedPersonalDocument }) {
  return <Modal open title="Personal document" onClose={clearPersonalDocument} size="sm"
    footer={<div className="flex gap-2">{Boolean(document.remaining) && <button type="button" className="rounded-md border border-line px-3 py-1.5 text-sm" onClick={nextPersonalDocument}>Next document</button>}<button type="button" className="rounded-md border border-line px-3 py-1.5 text-sm" onClick={clearPersonalDocument}>Close</button></div>}>
    <div className="space-y-3">{document.file && "name" in document.file && <p className="break-words text-sm font-medium">{String(document.file.name)}</p>}{(document.read.kind === "registration" || document.read.renewalType) && document.file ? <DocumentRenewalCard key={document.id ?? JSON.stringify(document.read.fields)} slug={document.orgSlug} read={document.read} file={document.file} folder={document.folder} /> : <PersonalDocumentCard key={document.id ?? document.remaining ?? 0} read={document.read} file={document.file} />}{Boolean(document.remaining) && <p className="text-sm text-muted">{document.remaining} more personal documents are waiting here. Closing clears their values too.</p>}</div>
  </Modal>;
}
