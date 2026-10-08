import type { Request, Response, NextFunction } from "express";
import { isStoredSecret, maskSecretValues, omitSecretValues } from "@cobblr/platform-contract/secret-field";
import { csvCellAsWritten } from "@cobblr/platform-contract/csv";
import { parseCsv } from "./field-scope-projection.js";
import { secretReadContextFor } from "./secret-fields.js";
import { perRequest } from "../lib/request-context.js";
import { meta } from "../db/meta.js";

export function csvWithoutSecrets(text: string, names: ReadonlySet<string>): string {
  const bom = text.startsWith("\uFEFF");
  const rows = parseCsv(bom ? text.slice(1) : text);
  if (!rows.length) return text;
  const dropped = new Set(rows[0]!.flatMap((name, index) => names.has(name.trim()) ? [index] : []));
  for (const row of rows.slice(1)) {
    for (const [index, cell] of row.entries()) {
      if (!cell.includes("__cobblr_secret")) continue;
      try {
        const value: unknown = JSON.parse(cell);
        if (isStoredSecret(value)) dropped.add(index);
        else row[index] = JSON.stringify(omitSecretValues(value));
      } catch { row[index] = ""; }
    }
  }
  const keep = rows[0]!.map((_name, index) => index).filter((index) => !dropped.has(index));
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  return (bom ? "\uFEFF" : "") + rows.map((row) => keep.map((index) => csvCellAsWritten(row[index] ?? "")).join(",")).join(eol) + eol;
}

export async function protectSecretResponses(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (res.locals.secretProjection) return;
  const tenant = req.tenant!;
  const context = await secretReadContextFor(tenant.org.id, req.session!.id, tenant.role);
  res.locals.secretProjection = true;
  const json = res.json.bind(res);
  res.json = ((body: unknown) => json(maskSecretValues(body, context))) as typeof res.json;
  const send = res.send.bind(res);
  res.send = ((body: unknown) => {
    if (res.locals.secretExport || !/text\/csv/i.test(String(res.getHeader("Content-Type") ?? "")) || !(typeof body === "string" || Buffer.isBuffer(body))) return send(body);
    void perRequest(`secret-export-columns:${tenant.org.id}`, () => meta.selectFrom("module_field_defs").select(["name", "display_label"]).where("org_id", "=", tenant.org.id).where("type", "=", "secret").execute())
      .then((defs) => {
        if (defs.length) res.set("X-Export-Secrets", "omitted");
        return send(csvWithoutSecrets(Buffer.isBuffer(body) ? body.toString("utf8") : body, new Set(defs.flatMap((def) => [def.name, def.display_label]))));
      })
      .catch(next);
    return res;
  }) as typeof res.send;
}
