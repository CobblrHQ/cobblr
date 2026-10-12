// The documents in the inbox with no rows to show as tiles: a receipt whose
// read failed, or one being read. The gallery is a grid of item photos, so
// these used to vanish from it, Read again with them, while the list still
// had them (#6034). They stand above the tiles as what they are, documents,
// each with its own verdict and Read again.
import type { SessionVerdict } from "@cobblr/platform-contract/scan-session";
import { DocumentSessionCard } from "./DocumentSessionCard";
import { SessionReadVerdict } from "./SessionReadVerdict";

export interface InboxDocument {
  key: string;
  batchId: string;
  fileId: string | null;
  name: string;
  state: string | null;
  verdict: SessionVerdict;
}

export function InboxDocuments({
  slug,
  documents,
  readingBatch,
  onReadAgain,
  onOpen,
}: {
  slug: string;
  documents: InboxDocument[];
  /** The session a Read again is in flight for, before its poll says so. */
  readingBatch: string | null;
  onReadAgain: (batchId: string) => void;
  onOpen: (fileId: string) => void;
}) {
  if (!documents.length) return null;
  return (
    <section data-testid="inbox-documents" aria-label="Documents not read yet" className="space-y-2">
      <h3 className="text-[10px] font-mono uppercase tracking-widest text-accent">
        {documents.length === 1 ? "1 document not read yet" : `${documents.length} documents not read yet`}
      </h3>
      {documents.map((d) => (
        <div key={d.key} data-testid="inbox-document" className="space-y-1.5">
          {d.fileId ? (
            <DocumentSessionCard slug={slug} fileId={d.fileId} name={d.name} state={d.state} onOpen={onOpen} />
          ) : (
            <div className="rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-2 text-sm text-content">{d.name}</div>
          )}
          <SessionReadVerdict
            verdict={d.verdict}
            reading={readingBatch === d.batchId}
            onReadAgain={() => onReadAgain(d.batchId)}
            configureAiHref={`/w/${slug}/configuration/ai`}
          />
        </div>
      ))}
    </section>
  );
}
