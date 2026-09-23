// Which instance a module request is for.
//
// The kernel's resolveInstance middleware stamps `req.instance` on the
// /instances/:name/items routes. A legacy /modules/<name>/... route carries
// none, and there the module's own name is the instance: the default every
// instanced table's `instance_name` column carries, so legacy rows and the
// default instance line up. Seven modules read this with a private cast
// (#3499); a module now names only its default.

export function requestInstance(req: unknown, moduleDefault: string): string {
  const inst = typeof req === "object" && req !== null ? (req as { instance?: unknown }).instance : undefined;
  return typeof inst === "string" && inst ? inst : moduleDefault;
}
