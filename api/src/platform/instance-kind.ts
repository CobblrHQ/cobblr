// The ONE grammar for an instance kind string. `<instance>:item` names the
// instance a record lives in (a Groceries table's rows are `groceries:item`);
// a module's own kind is `<module>:<type>` and is never parsed this way.
// Pure of the database so the rule is a test; resolveKind in entities.ts
// checks the registry first, because a genuine module kind can look like an
// instance one (`lists:item`).

export function instanceKindName(kind: string): string | null {
  const m = /^([a-z0-9][a-z0-9-]*):item$/.exec(kind);
  return m ? m[1]! : null;
}
