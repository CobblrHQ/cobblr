// The personal-path door a bill of sale is filed through (#5331): a multipart
// upload that is read and filed, never stored. Shared by the bill-of-sale tests.
import { BASE, org, type TestSession } from "./helpers.js";

export async function fileBillOfSale<T = { items: Array<{ id: string }>; batch_id: string | null; read_by: string }>(
  s: TestSession,
  page: Blob,
  name: string,
  fields: Record<string, string> = {},
): Promise<T> {
  const form = new FormData();
  form.append("file", page, name);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const r = await fetch(`${BASE}${org(s, "/modules/core-scan/personal-documents/bill-of-sale")}`, { method: "POST", headers: { Authorization: `Bearer ${s.token}` }, body: form });
  if (!r.ok) throw new Error(`bill of sale ${r.status}: ${await r.text()}`);
  return (await r.json()) as T;
}
