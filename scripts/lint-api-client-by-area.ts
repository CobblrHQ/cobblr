#!/usr/bin/env tsx
// A web client call goes in its area file under web/src/lib/api/, never in the web/src/lib/api.ts barrel or the shared client.ts, so two feature PRs in different areas never touch one file.
//
// THE BUG THIS PREVENTS. #7364 (2026-10-18): 49 of the 62 regenerated heads
// the merge queue had to re-run in one day shared web/src/lib/api.ts, the one
// file every feature PR appended its calls to, so any two feature PRs
// collided, re-checked and held each other through a freeze.
//
// THE RULE.
//   - web/src/lib/api.ts only re-exports: `export * from "./api/<area>"`,
//     `import { <area>Api } from "./api/<area>"`, and the `api` object made of
//     `...<area>Api` spreads. Any other statement or member fails.
//   - web/src/lib/api/client.ts is the shared transport (the token, the one
//     `request<T>`, its error shape, connectivity, uploads). A top-level name
//     not in CLIENT_PUBLIC or CLIENT_INTERNAL fails, and so does an endpoint path that is not one
//     of the transport's own (CLIENT_PATHS).
// The failure names the area file that already calls the endpoint's route,
// or the new file to start for a route no area calls yet.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. client.ts has to hold
// paths of its own: the `/api/v1${path}` it prefixes and primaryBase's
// generic `/orgs/${slug}/modules/${moduleRoute}`, which name no route. They
// are listed by text, so a route written there by hand is still caught.
// Growing the transport itself is a deliberate edit to CLIENT_PUBLIC or
// CLIENT_INTERNAL.
//
// PROVE IT RED before you trust it green: run it against the real violation
// that motivated it, watch it fail, then fix the violation. A lint that has
// never failed has never been verified.
//
//   npx tsx scripts/lint-api-client-by-area.ts   (pnpm lint api-client-by-area)
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";

const BARREL = "web/src/lib/api.ts";
const AREAS = "web/src/lib/api";
const CLIENT = `${AREAS}/client.ts`;

/** The transport's own top-level names (#7364): what pages may import through
 *  the barrel, and the internals only area files use (a page calls an area's
 *  method, never `request` with a path of its own). */
const CLIENT_PUBLIC = new Set([
  "accountToken", "getToken", "sessionIdentity", "setToken", "SESSION_CHANGED", "fetchAuthBlobUrl", "fetchCsv", "ApiError",
  "subscribeConnectivity", "subscribeOfflineCopies", "OFFLINE_SENTENCE", "pingHealth", "subscribeWorkspaceShape", "noteWorkspaceShape",
  "subscribeAiAvailability", "idsThatFitAUrl",
  // re-exported from @cobblr/platform-web
  "subscribeWorkspaceWrite", "subscribeDeletedRecord",
]);
const CLIENT_INTERNAL = new Set([
  "TOKEN_KEY", "upload", "sendUploadCounted", "ConnListener", "connListeners", "apiDown", "setApiDown", "OfflineListener",
  "offlineListeners", "offlineAsOf", "setOfflineAsOf", "API_ANSWERED_5XX", "answeredByTheApi", "ShapeListener", "shapeListeners",
  "seenShape", "aiListeners", "noteAiAvailabilityWrite", "lookupInBody", "request", "carryingOn", "sendRequest", "primaryBase",
  "filed", "browserTimeZone",
]);
const CLIENT_NAMES = new Set([...CLIENT_PUBLIC, ...CLIENT_INTERNAL]);

/** The transport's own path templates, which name no route. */
const CLIENT_PATHS = new Set(["`/api/v1${path}`", "`/api/v1/healthz`", "`/orgs/${slug}/instances/${instance}/items`", "`/orgs/${slug}/modules/${moduleRoute}`"]);

interface Violation {
  file: string;
  line: number;
  what: string;
}

const parse = (file: string, src: string) => ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const lineOf = (sf: ts.SourceFile, n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

function areaFiles(): string[] {
  return readdirSync(AREAS).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts") && n !== "client.ts").map((n) => `${AREAS}/${n}`);
}

/** The part of an endpoint that says whose it is: a module, an org route, a /me route or a top-level one. */
function routeKey(path: string): { key: string; fresh: string } | null {
  const p = path.replace(/^[`"']/, "").replace(/^\/api\/v1/, "");
  let m = p.match(/^\/orgs\/\$\{[^}]+\}\/modules\/([a-z0-9-]+)\//) ?? p.match(/^\/orgs\/\$\{[^}]+\}\/modules\/([a-z0-9-]+)\b/);
  if (m) return { key: `/modules/${m[1]}`, fresh: m[1]!.replace(/^core-/, "") };
  m = p.match(/^\/orgs\/\$\{[^}]+\}\/([a-z0-9-]+)/);
  if (m) return { key: `}/${m[1]}`, fresh: m[1]! };
  m = p.match(/^\/(me|[a-z0-9-]+)(?:\/([a-z0-9-]+))?/);
  if (m) return { key: m[2] ? `/${m[1]}/${m[2]}` : `/${m[1]}`, fresh: m[1] === "me" ? (m[2] ?? "account") : m[1]! };
  return null;
}

/** The area file that already calls this route the most, or the new one to start. */
function homeFor(path: string, areas: Map<string, string>): string {
  const r = routeKey(path);
  if (!r) return `its area file under ${AREAS}/`;
  let best: [string, number] | null = null;
  for (const [file, src] of areas) {
    const n = src.split(r.key).length - 1;
    if (n && (!best || n > best[1])) best = [file, n];
  }
  return best ? best[0] : `${AREAS}/${r.fresh}.ts (a new area file: export const ${r.fresh.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())}Api, then spread it into the barrel)`;
}

function pathsIn(node: ts.Node, sf: ts.SourceFile): Array<{ text: string; line: number }> {
  const out: Array<{ text: string; line: number }> = [];
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) {
      const t = n.getText(sf);
      if (/^[`"']\/(api\/v1\/?|orgs\/|me\b|[a-z])/.test(t)) out.push({ text: t, line: lineOf(sf, n) });
    }
    // primaryBase(slug, "machines/machines", instance) is /orgs/:slug/modules/machines/machines.
    if (ts.isCallExpression(n) && n.expression.getText(sf) === "primaryBase" && n.arguments[1] && ts.isStringLiteral(n.arguments[1])) {
      out.push({ text: `\`/orgs/\${slug}/modules/${n.arguments[1].text}\``, line: lineOf(sf, n) });
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

const namesOf = (st: ts.Statement): string[] =>
  ts.isVariableStatement(st)
    ? st.declarationList.declarations.map((d) => d.name.getText())
    : "name" in st && st.name && ts.isIdentifier(st.name as ts.Node)
      ? [(st.name as ts.Identifier).text]
      : [];

function checkBarrel(src: string, areas: Map<string, string>, file = BARREL): Violation[] {
  const sf = parse(file, src);
  const out: Violation[] = [];
  const area = (spec: ts.Expression | undefined) => !!spec && ts.isStringLiteral(spec) && /^\.\/api\/[a-z0-9-]+$/.test(spec.text);
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st) && !st.exportClause && area(st.moduleSpecifier)) continue;
    // The client's public names, by name: its internals (request, primaryBase) stay out of the barrel.
    if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) && st.moduleSpecifier.text === "./api/client") {
      for (const el of st.exportClause.elements) {
        const name = (el.propertyName ?? el.name).text;
        if (CLIENT_PUBLIC.has(name)) continue;
        out.push({ file, line: lineOf(sf, el), what: CLIENT_INTERNAL.has(name) ? `${name} is the client's internal: a page calls an area's method, so the barrel never hands it out` : `${name} is not one of client.ts's own names; export it from its area file` });
      }
      continue;
    }
    if (ts.isImportDeclaration(st) && area(st.moduleSpecifier)) continue;
    if (ts.isVariableStatement(st) && st.declarationList.declarations.length === 1) {
      const d = st.declarationList.declarations[0]!;
      if (d.name.getText(sf) === "api" && d.initializer && ts.isObjectLiteralExpression(d.initializer)) {
        for (const p of d.initializer.properties) {
          if (ts.isSpreadAssignment(p) && /^[a-z][A-Za-z0-9]*Api$/.test(p.expression.getText(sf))) continue;
          const where = pathsIn(p, sf)[0];
          out.push({ file, line: lineOf(sf, p), what: `api.${p.name?.getText(sf) ?? "?"} belongs in ${where ? homeFor(where.text, areas) : `its area file under ${AREAS}/`}; the barrel only spreads <area>Api objects` });
        }
        continue;
      }
    }
    const where = pathsIn(st, sf)[0];
    const name = namesOf(st)[0] ?? st.getText(sf).split("\n")[0]!.slice(0, 60);
    out.push({ file, line: lineOf(sf, st), what: `${name} belongs in ${where ? homeFor(where.text, areas) : `its area file under ${AREAS}/`}; ${BARREL} only re-exports` });
  }
  return out;
}

function checkClient(src: string, areas: Map<string, string>, file = CLIENT): Violation[] {
  const sf = parse(file, src);
  const out: Violation[] = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) continue;
    for (const name of namesOf(st)) {
      if (CLIENT_NAMES.has(name)) continue;
      const where = pathsIn(st, sf)[0];
      out.push({ file, line: lineOf(sf, st), what: `${name} is not the shared transport: put it in ${where ? homeFor(where.text, areas) : "the area file that calls it"} (growing the transport itself is an edit to CLIENT_PUBLIC or CLIENT_INTERNAL in this lint)` });
    }
    if (namesOf(st).some((n) => !CLIENT_NAMES.has(n))) continue;
    for (const p of pathsIn(st, sf)) {
      if (CLIENT_PATHS.has(p.text)) continue;
      out.push({ file, line: p.line, what: `the endpoint ${p.text} belongs in ${homeFor(p.text, areas)}, not the shared client` });
    }
  }
  return out;
}

// An area's record calls name their module through primaryBase(slug, "machines/machines").
const areas = new Map(areaFiles().map((f) => [f, readFileSync(f, "utf8").replace(/primaryBase\(\s*\w+\s*,\s*"/g, "/modules/")]));
const violations = [...checkBarrel(readFileSync(BARREL, "utf8"), areas), ...checkClient(readFileSync(CLIENT, "utf8"), areas)];
if (violations.length) {
  console.error(`lint:api-client-by-area - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("Every web client call lives in its area file under web/src/lib/api/, so two feature PRs in different areas touch no common file (#7364).");
  process.exit(1);
}
console.log(`lint:api-client-by-area OK - ${areas.size} area files; the barrel only re-exports and client.ts holds no endpoint`);
