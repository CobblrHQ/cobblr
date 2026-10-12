import type { PersonalDocumentRead } from "@cobblr/platform-contract/personal-documents";
export interface RaisedPersonalDocument { orgSlug: string; read: PersonalDocumentRead; file: File | Blob | null; remaining?: number; folder?: string; id?: number }
type Listener = (value: RaisedPersonalDocument | null) => void;
const listeners = new Set<Listener>();
const pending: RaisedPersonalDocument[] = [];
let nextId = 0;
function current(): RaisedPersonalDocument | null { return pending[0] ? { ...pending[0], remaining: pending.length - 1 } : null; }
function publish(): void { const value = current(); listeners.forEach((listener) => listener(value)); }
export function raisePersonalDocument(value: RaisedPersonalDocument): void {
  if (!listeners.size) return;
  pending.push({ ...value, id: ++nextId }); publish();
}
export function clearPersonalDocument(): void { pending.length = 0; publish(); }
export function nextPersonalDocument(): void { pending.shift(); publish(); }
export function subscribePersonalDocument(listener: Listener): () => void {
  listeners.add(listener); listener(current());
  return () => { listeners.delete(listener); if (!listeners.size) pending.length = 0; };
}
