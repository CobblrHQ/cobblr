import { walkPages } from "../list-pages";
import { primaryBase, request } from "./client";
import type { Edit } from "@cobblr/platform-web";
import { downloadBlob } from "@cobblr/platform-web";

/** A row in the records module — the neutral generic-record substrate.
 *  Named RecordItem (not Record) to dodge TS's builtin Record type. */
export interface RecordItem {
  id: string;
  name: string;
  image_path: string | null;
  notes: string | null;
  location_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export const recordsApi = {

  // records module (instance? scopes to /instances/:name/items)
  listRecords: (slug: string, instance?: string) =>
    walkPages<RecordItem>((offset, limit) =>
      request<{ items: RecordItem[]; total?: number | null; complete?: boolean }>("GET", `${primaryBase(slug, "records/records", instance)}?offset=${offset}&limit=${limit}`),
    ),
  getRecord: (slug: string, id: string, instance?: string) =>
    request<RecordItem>("GET", `${primaryBase(slug, "records/records", instance)}/${id}`),
  createRecord: (slug: string, body: Partial<RecordItem>, instance?: string) =>
    request<RecordItem>("POST", primaryBase(slug, "records/records", instance), body),
  /** `edit` from editOf: only what changed, and what it was when the form opened (#7925). */
  updateRecord: (slug: string, id: string, edit: Edit<RecordItem>, instance?: string) =>
    request<RecordItem>("PATCH", `${primaryBase(slug, "records/records", instance)}/${id}`, edit.body, edit.headers),
  deleteRecord: (slug: string, id: string, instance?: string) =>
    request<void>("DELETE", `${primaryBase(slug, "records/records", instance)}/${id}`),
  recordStreamTicket: (slug: string) => request<{ ticket: string }>("POST", `/orgs/${slug}/records/stream-ticket`),
  sendTargets: (slug: string) => request<import("@cobblr/platform-web").WorkspaceSendTargets>("GET", `/orgs/${slug}/records/send-targets`),
  previewSendFile: (slug: string,p: {entity_kind: string;ids: string[];mode: "copy" | "move"}) => request<import("@cobblr/platform-web").SendFileExportPreview>("POST",`/orgs/${slug}/records/send/file`,{...p,dry_run: true}),
  exportSendFile: (slug: string,p: {entity_kind: string;ids: string[];mode: "copy" | "move";request_id?: string}) => request<{id: string;download_path: string;summary: string}>("POST",`/orgs/${slug}/records/send/file`,p),
  downloadSendFile: async (slug: string,id: string) => {const data = await request<unknown>("GET",`/orgs/${slug}/records/send/file/${id}/download`); downloadBlob(new Blob([JSON.stringify(data)],{type: "application/json"}),`cobblr-send-${id}.json`);},
  importSendFile: (slug: string,p: {packet: import("@cobblr/platform-contract/send-file").SendFile;collection?: string | null;field_map?: Record<string,string | null>;create_matching?: boolean;add_fields?: string[];placement?: "unplaced";location?: string | null;duplicate?: "update" | "another";request_id?: string;dry_run?: boolean}) => request<import("@cobblr/platform-web").WorkspaceSendPreview & {can_configure?: boolean;collections?: Array<{kind: string;label: string}>;version_warnings?: string[];import_id?: string;sent?: number;receipt?: import("@cobblr/platform-contract/send-file").SendReceipt;summary?: string}>("POST",`/orgs/${slug}/records/send/file/import`,p),
  downloadSendFileReceipt: async (slug: string,id: string,phase: "imported" | "undone") => {const r = await request<unknown>("GET",`/orgs/${slug}/records/send/file/imports/${id}/receipt/${phase}`);downloadBlob(new Blob([JSON.stringify(r)],{type: "application/json"}),`cobblr-${phase === "undone" ? "return" : "confirmation"}-${id}.json`);},
  undoSendFileImport: (slug: string,id: string) => request<{receipt: import("@cobblr/platform-contract/send-file").SendReceipt;summary: string}>("POST",`/orgs/${slug}/records/send/file/imports/${id}/undo`,{}),
  confirmSendFile: (slug: string,receipt: import("@cobblr/platform-contract/send-file").SendReceipt,dry_run = false) => request<{summary: string;items?: number;mode?: string;target?: {name: string;instance: string;person: string}}>("POST",`/orgs/${slug}/records/send/file/confirm`,{receipt,dry_run}),
  restoreSendFileSource: (slug: string,receipt: import("@cobblr/platform-contract/send-file").SendReceipt,dry_run = false) => request<{summary: string;items?: number;target?: {name: string;instance: string;person: string}}>("POST",`/orgs/${slug}/records/send/file/restore`,{receipt,dry_run}),
  previewSend: (slug: string, p: import("@cobblr/platform-web").WorkspaceSendRequest) => request<import("@cobblr/platform-web").WorkspaceSendPreview>("POST", `/orgs/${slug}/records/send`, { ...p, dry_run: true }),
  sendRecords: (slug: string, p: import("@cobblr/platform-web").WorkspaceSendRequest) => request<{ summary: string; offer_ids: string[]; connected?: boolean }>("POST", `/orgs/${slug}/records/send`, p),
  undoSend: (slug: string, id: string, restore = false) => request<{summary?: string;restore_available?: boolean}>("POST", `/orgs/${slug}/records/send/${id}/undo`, {restore_source: restore}),
};
