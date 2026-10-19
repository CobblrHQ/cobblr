#!/usr/bin/env tsx
// A web file that calls a write its route keeps above a member (requireRole with no member in its list) asks the gate itself (useCan, useRoleAtLeast) or is reached only through a page that does: a member is never drawn a control, or sent a request, the server always refuses.
//
// THE BUG THIS PREVENTS. Five pages offered or probed what their viewer's
// role could not use: a calendar feed's Rotate for a member (#7507),
// embroidery's station lists (#7509, #7510), control of an arm (#7522), a
// list deletion (#7524). And a managed app's shell sent every viewer's first
// page POST /refresh-app, an owner-and-admin route, so each member's session
// opened on a 403 (found by this lint, #7552, 2026-10-19).
//
// THE RULE. The kernel's write routes (api/src) whose every requireRole list
// leaves a member out are read as code, the web client's methods
// (web/src/lib/api) matched to them by verb and path, and every web file that
// calls one is judged. It passes when it asks a gate itself (useCan,
// useRoleAtLeast, useCapabilities, roleSatisfies, ManagedByAdmins, pageOpenTo),
// or when every way a member reaches it runs through a file that does, or
// through a route a member is not let into (a configuration page whose
// minRole is above a member: ConfigurationLayout draws ManagedByAdmins
// there). Reach is followed up the static imports to App.tsx: a file App.tsx
// imports outright is drawn on every page; one it routes to lazily is reached
// at that route.
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. A file-by-file reading
// flagged the sharing, portal, presentation and actions settings pages and
// the sections inside them: ConfigurationLayout already keeps a member out of
// them by their minRole. So reach through the routes is followed, not the
// file alone. Not yet judged: a module's own routes and clients, and
// requireCapability gates (whether a member holds a capability is a grant,
// not code); useCan is the gate for those, and the role pass sees their
// refused reads.
//
// PROVED RED on main: web/src/components/AppLayout.tsx (refreshApp, an
// owner/admin route, sent on every managed app's first page).
//
//   npx tsx scripts/lint-gated-writes-ask-the-gate.ts   (pnpm lint gated-writes-ask-the-gate)
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import ts from "typescript";
import * as orgRoles from "../packages/platform-contract/src/org-roles.ts";
import { pageOpenTo } from "../web/src/lib/configuration-nav.ts";
import { repoFiles, repoFilesContaining } from "./lib/repo-files.ts";

interface Violation {
  file: string;
  line: number;
  what: string;
}

const PROBE_ROLE = "member";
const GATE = /\b(useCan|useRoleAtLeast|useCapabilities|useCapabilitiesFor|roleSatisfies|ManagedByAdmins|pageOpenTo)\b/;

const notTests = (fs: string[]) => fs.filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
const parse = (file: string, src: string) => ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
/** A path with every parameter alike: `/orgs/${slug}/x/${id}` and `/:slug/x/:id` both read /orgs/:p/x/:p. */
const shape = (p: string) => p.replace(/\$\{[^}]+\}/g, ":p").replace(/:[A-Za-z_]\w*/g, ":p").replace(/\?.*$/, "").replace(/\/+$/, "");

/** Does every request reach this gate? Its own `if (!requireRole(...)) return;`
 *  may hold it, but no other branch: share-links' revoke lets a person revoke
 *  their own connection whatever their role and asks requireRole only in the
 *  else (#7552). */
function unconditional(call: ts.Node): boolean {
  let own = true;
  for (let n = call.parent; n && !ts.isFunctionLike(n); n = n.parent) {
    if (ts.isIfStatement(n) || ts.isConditionalExpression(n) || ts.isBinaryExpression(n) && /^(&&|\|\||\?\?)$/.test(n.operatorToken.getText()) || ts.isCaseClause(n)) {
      if (own && ts.isIfStatement(n) && n.expression.pos <= call.pos && call.end <= n.expression.end) { own = false; continue; }
      if (own && ts.isPrefixUnaryExpression(call.parent)) continue;
      return false;
    }
  }
  return true;
}

/** "POST /orgs/:p/refresh-app" → the role list that route reads. */
export function memberRefusedRoutes(files: Array<[string, string]>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [file, src] of files) {
    if (!src.includes("requireRole(")) continue;
    const sf = parse(file, src);
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && /^(post|put|patch|delete)$/.test(n.expression.name.text) && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) {
        const lists: string[][] = [];
        let unread = false;
        const inner = (m: ts.Node) => {
          if (ts.isCallExpression(m) && ts.isIdentifier(m.expression) && m.expression.text === "requireRole" && unconditional(m)) {
            const list: string[] = [];
            for (const a of m.arguments.slice(2)) {
              if (ts.isStringLiteral(a)) list.push(a.text);
              else if (ts.isSpreadElement(a) && ts.isIdentifier(a.expression) && Array.isArray((orgRoles as Record<string, unknown>)[a.expression.text])) list.push(...((orgRoles as Record<string, unknown>)[a.expression.text] as string[]));
              else unread = true;
            }
            lists.push(list);
          }
          ts.forEachChild(m, inner);
        };
        n.arguments.slice(1).forEach(inner);
        const path = n.arguments[0].text;
        if (!unread && lists.length && lists.every((l) => !orgRoles.roleSatisfies(PROBE_ROLE, l))) out.set(`${n.expression.name.text.toUpperCase()} ${shape(path.startsWith("/:slug") ? `/orgs${path}` : path)}`, lists[0]!);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

/** The web client's methods that call one of `routes`: name → "VERB /path". */
export function clientMethodsOn(files: Array<[string, string]>, routes: Map<string, string[]>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [file, src] of files) {
    const sf = parse(file, src);
    const visit = (n: ts.Node) => {
      if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name)) {
        let hit: string | null = null;
        const inner = (m: ts.Node) => {
          if (!hit && ts.isCallExpression(m) && ts.isIdentifier(m.expression) && m.expression.text === "request" && m.arguments.length >= 2 && ts.isStringLiteral(m.arguments[0]!)) {
            const a = m.arguments[1]!;
            const p = ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a) ? a.text : ts.isTemplateExpression(a) ? a.getText(sf).slice(1, -1) : null;
            if (p) hit = `${(m.arguments[0] as ts.StringLiteral).text} ${shape(p)}`;
          }
          ts.forEachChild(m, inner);
        };
        inner(n.initializer);
        if (hit && routes.has(hit)) out.set(n.name.text, hit);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

const resolveImport = (from: string, spec: string): string | null => {
  if (!spec.startsWith(".")) return null;
  const base = normalize(join(dirname(from), spec));
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) if (/\.(ts|tsx)$/.test(c) && existsSync(c)) return c;
  return null;
};

/** Who imports each web file, and which route paths App.tsx draws each lazily-loaded page at. */
function reach(webFiles: Array<[string, string]>) {
  const importers = new Map<string, Set<string>>();
  const routedAt = new Map<string, string[]>();
  const add = (to: string, from: string) => (importers.get(to) ?? importers.set(to, new Set()).get(to)!).add(from);
  for (const [file, src] of webFiles) {
    const sf = parse(file, src);
    const lazyNames = new Map<string, string>();
    const visit = (n: ts.Node) => {
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && !n.importClause?.isTypeOnly) {
        const to = resolveImport(file, n.moduleSpecifier.text);
        if (to) add(to, file);
      }
      // const X = lazy(() => import("./pages/X")...): reached at X's routes when in App.tsx, else where X is drawn.
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) {
        const to = resolveImport(file, n.arguments[0].text);
        let decl: ts.Node | undefined = n.parent;
        while (decl && !ts.isVariableDeclaration(decl)) decl = decl.parent;
        // A bare import() warms a chunk (route-prefetch.ts) and draws nothing; only lazy() draws it.
        let inLazy = false;
        for (let a: ts.Node | undefined = n.parent; a && !inLazy; a = a.parent) if (ts.isCallExpression(a) && a.expression.getText(sf) === "lazy") inLazy = true;
        if (to && inLazy && file === "web/src/App.tsx" && decl && ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) lazyNames.set(decl.name.text, to);
        else if (to && inLazy) add(to, file);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    if (file !== "web/src/App.tsx") continue;
    // <Route path="/x" element={<X />} />
    const routes = (n: ts.Node) => {
      if ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && n.tagName.getText(sf) === "Route") {
        let path: string | null = null;
        const els: string[] = [];
        for (const a of n.attributes.properties) {
          if (!ts.isJsxAttribute(a) || !a.initializer) continue;
          const name = a.name.getText(sf);
          if (name === "path" && ts.isStringLiteral(a.initializer)) path = a.initializer.text;
          if (name === "element") a.initializer.forEachChild(function tags(c): void {
            if ((ts.isJsxSelfClosingElement(c) || ts.isJsxOpeningElement(c)) && lazyNames.has(c.tagName.getText(sf))) els.push(lazyNames.get(c.tagName.getText(sf))!);
            c.forEachChild(tags);
          });
        }
        for (const el of els) (routedAt.get(el) ?? routedAt.set(el, []).get(el)!).push(path ?? "/");
      }
      ts.forEachChild(n, routes);
    };
    routes(sf);
    // A lazy page App.tsx never routes (drawn some other way) is reached as if imported.
    for (const to of lazyNames.values()) if (!routedAt.has(to)) add(to, file);
  }
  return { importers, routedAt };
}

export function check(): Violation[] {
  const read = (fs: string[]) => fs.map((f) => [f, readFileSync(f, "utf8")] as [string, string]);
  const routes = memberRefusedRoutes(read(notTests(repoFilesContaining("requireRole(", ["api/src"]))));
  const methods = clientMethodsOn(read(notTests(repoFiles(["web/src/lib/api.ts", "web/src/lib/api"]))), routes);
  const web = read(notTests(repoFiles(["web/src"])));
  const src = new Map(web);
  const { importers, routedAt } = reach(web);
  const gated = (f: string) => GATE.test(src.get(f) ?? "");
  // Can a member reach `f` without passing a gate? Followed up the importers to App.tsx.
  const memo = new Map<string, string | null>();
  const openPath = (f: string, seen: Set<string>): string | null => {
    if (memo.has(f)) return memo.get(f)!;
    if (seen.has(f)) return null;
    seen.add(f);
    let found: string | null = null;
    if (gated(f)) found = null;
    else if (f === "web/src/App.tsx" || f === "web/src/main.tsx") found = f;
    else {
      for (const at of routedAt.get(f) ?? []) if (pageOpenTo(at.startsWith("/") ? at : `/${at}`, PROBE_ROLE)) { found = `the route ${at}`; break; }
      if (!found) for (const by of importers.get(f) ?? []) { const via = openPath(by, seen); if (via) { found = by === via ? by : `${by} ← ${via}`.split(" ← ").slice(0, 3).join(" ← "); break; } }
    }
    memo.set(f, found);
    return found;
  };
  const out: Violation[] = [];
  for (const [file, text] of web) {
    if (file.startsWith("web/src/lib/api")) continue;
    for (const [name, route] of methods) {
      // A call draws or sends it; a reference handed on (the provider's client) does not.
      const at = text.search(new RegExp(`\\bapi\\.${name}!?\\s*\\(`));
      if (at < 0) continue;
      const via = openPath(file, new Set());
      if (!via) continue;
      out.push({ file, line: text.slice(0, at).split("\n").length, what: `api.${name} is ${route}, refused to a ${PROBE_ROLE} (requireRole ${routes.get(route)!.join(", ")}), and a ${PROBE_ROLE} reaches it with no gate (via ${via})` });
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations = check();
  if (violations.length) {
    console.error(`lint:gated-writes-ask-the-gate - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error("Ask useRoleAtLeast(<the route's contract list>) or useCan(<action>) from web/src/lib/can.ts before drawing the control or sending the request (#7552).");
    process.exit(1);
  }
  console.log("lint:gated-writes-ask-the-gate OK");
}
