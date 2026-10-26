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
// file alone.
//
// MODULE ROUTES AND CAPABILITIES (#7922). A module's own routes are read too,
// at the path their routers are mounted under (`.use("/jobs", jobsRouter)`),
// and so is a requireCapability gate whose action a plain member holds by no
// declaration: no runBy a member satisfies (an operator's is not theirs), no
// heldBy naming "member", not a member default. Members were offered Send on
// every queued print and an operator was offered to authorize a station, and
// both were refused after the tap (#7892, #7947); this found 64 such calls.
// The client a host hands a shared package (<PlatformWebProvider api={{…}}>)
// is wiring, not a control. A control drawn on the server's own answer for
// the person says so on a GATED-BY: line.
//
// A MODULE'S OWN UI (#8028). Its client (modules/*/src/ui/api.ts) is read as
// code: each method followed through the class's helpers and base path to
// the route it sends (`updatePart` → this.partsRequest → requestAbs →
// PATCH /orgs/:p/modules/inventory/parts/:p), and so is a workspaceFetch a UI
// file sends itself. There the file that calls one asks the gate itself, or
// says on a GATED-BY: line what draws it only for those allowed: an
// importer's gate for some other control does not cover it (a list page's
// delete gate passed a part page's title edit). An endpoint capability
// (capability-grants.ts, `inventory:update-part`) is a capability a member
// does not hold unless the member defaults say so. This found members
// offered New part, Duplicate, Move, a unit's holder, the filament catalog,
// Spoolman, a label printer's settings and Forget, the builds stations'
// Authorize and Revoke, sales' Email and order intake, and tracking's delete.
//
// Still not judged: which control in a web file a gate covers (a web file
// with one gate passes), and a role other than a member (an operator's
// refusals are fixed where they were found).
//
// PROVED RED on main: web/src/components/AppLayout.tsx (refreshApp, an
// owner/admin route, sent on every managed app's first page), and
// modules/inventory/src/ui/PartDetailPage.tsx with its gates taken out
// (api.updatePart from the title, inventory:update-part), and
// web/src/pages/DigifabPage.tsx with its gates taken out (askSend's
// sendDigifabJob in startReview.tsx, digifab:send: 32 calls in all).
//
//   npx tsx scripts/lint-gated-writes-ask-the-gate.ts   (pnpm lint gated-writes-ask-the-gate)
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import ts from "typescript";
import * as orgRoles from "../packages/platform-contract/src/org-roles.ts";
import { pageOpenTo } from "../web/src/lib/configuration-nav.ts";
import { MEMBER_DEFAULT_CAPABILITIES } from "../api/src/platform/member-defaults.ts";
import { repoFiles, repoFilesContaining } from "./lib/repo-files.ts";

interface Violation {
  file: string;
  line: number;
  what: string;
}

const PROBE_ROLE = "member";
// A control drawn on the server's own answer for this person (a blocked
// action's selfApply, a kind's can_delete) says so on a GATED-BY: line.
const GATE = /\b(useCan|useRoleAtLeast|useCapabilities|useCapabilitiesFor|useMayDelete|roleSatisfies|ManagedByAdmins|pageOpenTo)\b|(\/\/|\/\*) GATED-BY: \S/;

// A page drawn only for the roles it lets in.
const PAGE_GATE = /\b(ManagedByAdmins|pageOpenTo)\b/;

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

/** Where a module's route is mounted: "/orgs/:p/modules/<name>" plus the
 *  prefixes its routers are `.use`d under, or null for a kernel file. */
export type PrefixOf = (file: string, router: string) => string | null;

/** "POST /orgs/:p/refresh-app" → the gate that route reads, as words: a role
 *  list, or the capability a member does not hold. */
export function memberRefusedRoutes(files: Array<[string, string]>, opts: { prefixOf?: PrefixOf; memberHolds?: (capability: string) => boolean | null } = {}): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [file, src] of files) {
    if (!src.includes("requireRole(") && !(opts.memberHolds && src.includes("requireCapability("))) continue;
    const sf = parse(file, src);
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && /^(post|put|patch|delete)$/.test(n.expression.name.text) && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) {
        const lists: string[][] = [];
        const caps: string[] = [];
        let unread = false;
        const inner = (m: ts.Node) => {
          // A capability gate a member does not hold by any declaration
          // (runBy, heldBy, the member defaults) refuses them as a role does.
          if (opts.memberHolds && ts.isCallExpression(m) && ts.isIdentifier(m.expression) && m.expression.text === "requireCapability" && unconditional(m) && m.arguments[2] && ts.isStringLiteral(m.arguments[2]) && opts.memberHolds(m.arguments[2].text) === false) caps.push(m.arguments[2].text);
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
        const router = ts.isIdentifier(n.expression.expression) ? n.expression.expression.text : "";
        const prefix = opts.prefixOf?.(file, router) ?? null;
        const full = prefix !== null ? `${prefix}${path === "/" ? "" : path}` : path.startsWith("/:slug") ? `/orgs${path}` : path;
        const verb = n.expression.name.text.toUpperCase();
        if (caps.length) out.set(`${verb} ${shape(full)}`, [`capability ${caps[0]}`]);
        else if (!unread && lists.length && lists.every((l) => !orgRoles.roleSatisfies(PROBE_ROLE, l))) out.set(`${verb} ${shape(full)}`, lists[0]!);
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

/** Each module router's mount: `<parent>.use("/jobs", jobsRouter)` read
 *  across the module's api files, up to the router nothing mounts. */
export function modulePrefixes(files: Array<[string, string]>): PrefixOf {
  const parentOf = new Map<string, { parent: string; at: string }>();
  const moduleOf = (file: string) => /^modules\/([^/]+)\/src\/api\//.exec(file)?.[1] ?? null;
  for (const [file, src] of files) {
    const m = moduleOf(file);
    if (!m || !src.includes(".use(")) continue;
    const sf = parse(file, src);
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "use" && ts.isIdentifier(n.expression.expression) && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) {
        const last = n.arguments[n.arguments.length - 1]!;
        if (ts.isIdentifier(last)) parentOf.set(`${m} ${last.text}`, { parent: n.expression.expression.text, at: n.arguments[0].text });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return (file, router) => {
    const m = moduleOf(file);
    if (!m) return null;
    let at = "";
    for (let r = router, hops = 0; parentOf.has(`${m} ${r}`) && hops < 8; hops++) {
      const p = parentOf.get(`${m} ${r}`)!;
      at = `${p.at === "/" ? "" : p.at}${at}`;
      r = p.parent;
    }
    return `/orgs/:p/modules/${m}${at}`;
  };
}

/** Does a plain member hold `capability` by a declaration the code makes:
 *  an action's runBy, a capability's heldBy, or the member defaults? null
 *  for an id nothing declares (not judged). */
export function memberHoldings(files: Array<[string, string]>, memberDefaults: readonly string[]): (capability: string) => boolean | null {
  const runBy = new Map<string, string | null>();
  const grantedAs = new Map<string, string>();
  const heldByMember = new Set<string>();
  const str = (o: ts.ObjectLiteralExpression, key: string) => {
    const p = o.properties.find((q): q is ts.PropertyAssignment => ts.isPropertyAssignment(q) && q.name.getText() === key);
    return p && ts.isStringLiteral(p.initializer) ? p.initializer.text : null;
  };
  for (const [file, src] of files) {
    const sf = parse(file, src);
    const visit = (n: ts.Node) => {
      if (ts.isObjectLiteralExpression(n)) {
        // An endpoint capability (capability-grants.ts) names itself action_id.
        const id = str(n, "id") ?? str(n, "action_id");
        if (id && /^[a-z0-9-]+:[a-z0-9-]+$/.test(id)) {
          if (!runBy.has(id) || str(n, "runBy") || str(n, "run_by")) runBy.set(id, str(n, "runBy") ?? str(n, "run_by"));
          const g = str(n, "grantedAs");
          if (g) grantedAs.set(id, g);
          const held = n.properties.find((q): q is ts.PropertyAssignment => ts.isPropertyAssignment(q) && q.name.getText() === "heldBy");
          if (held && ts.isArrayLiteralExpression(held.initializer) && held.initializer.elements.some((e) => ts.isStringLiteral(e) && e.text === PROBE_ROLE)) heldByMember.add(id);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return (capability) => {
    if (!runBy.has(capability)) return null;
    const ids = [capability, grantedAs.get(capability)].filter((x): x is string => !!x);
    const r = runBy.get(capability);
    // An operator shares a member's rank and is a member who runs the
    // machines: what runs by "operator" is not a plain member's.
    if (r && r !== "requester" && r !== "operator" && orgRoles.roleSatisfies(PROBE_ROLE, [r])) return true;
    return ids.some((i) => heldByMember.has(i) || memberDefaults.includes(i));
  };
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

type Fn = ts.FunctionLikeDeclaration;
const HTTP = /^(GET|POST|PUT|PATCH|DELETE)$/;
const SINKS = new Set(["workspaceFetch", "fetch"]);
const UPLOADS = /^upload[A-Z]?\w*$/;

/** Where a module UI client's request goes, read as code: each method's path
 *  and verb followed through the class's own helpers (`this.partsRequest`,
 *  `this.base()`), the parameters they are handed bound as they are called,
 *  to the workspaceFetch it ends in. A part it cannot read is a parameter
 *  (":p"). Also each bare workspaceFetch a UI file sends itself. */
export function clientRequests(file: string, src: string): { methods: Map<string, string>; direct: Array<{ at: number; request: string }> } {
  const sf = parse(file, src);
  const members = new Map<string, Fn>();
  const fnOf = (n: ts.Node): Fn | null => (ts.isMethodDeclaration(n) && n.body ? n : ts.isPropertyDeclaration(n) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)) ? n.initializer : null);
  const named = (n: ts.ClassElement) => (n.name && (ts.isIdentifier(n.name) || ts.isPrivateIdentifier(n.name)) ? n.name.text : null);
  sf.forEachChild(function classes(n): void {
    if (ts.isClassDeclaration(n)) for (const m of n.members) { const f = fnOf(m), name = named(m); if (f && name) members.set(name, f); }
    n.forEachChild(classes);
  });
  type Env = Map<string, string>;
  const local = (from: ts.Node, name: string): ts.Expression | null => {
    for (let f: ts.Node | undefined = from; f; f = f.parent) {
      if (!ts.isFunctionLike(f) && !ts.isSourceFile(f)) continue;
      let hit: ts.Expression | null = null;
      f.forEachChild(function find(c): void {
        if (!hit && ts.isVariableDeclaration(c) && ts.isIdentifier(c.name) && c.name.text === name && c.initializer && c.pos < from.pos) hit = c.initializer;
        if (!hit && !ts.isFunctionLike(c)) c.forEachChild(find);
      });
      if (hit) return hit;
    }
    return null;
  };
  const returned = (f: Fn): ts.Expression | null => {
    if (f.body && !ts.isBlock(f.body)) return f.body;
    let r: ts.Expression | null = null;
    f.body?.forEachChild(function find(c): void {
      if (!r && ts.isReturnStatement(c) && c.expression) r = c.expression;
      if (!r && !ts.isFunctionLike(c)) c.forEachChild(find);
    });
    return r;
  };
  const bind = (f: Fn, args: readonly ts.Expression[], env: Env, depth: number): Env => {
    const out: Env = new Map();
    f.parameters.forEach((p, i) => { if (ts.isIdentifier(p.name)) out.set(p.name.text, args[i] ? text(args[i]!, env, depth + 1) : ""); });
    return out;
  };
  const text = (e: ts.Expression, env: Env, depth = 0): string => {
    if (depth > 8) return ":p";
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) return text(e.expression, env, depth);
    if (ts.isTemplateExpression(e)) return e.head.text + e.templateSpans.map((s) => text(s.expression, env, depth + 1) + s.literal.text).join("");
    if (ts.isConditionalExpression(e)) return text(e.whenFalse, env, depth + 1);
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) return text(e.left, env, depth + 1) + text(e.right, env, depth + 1);
    if (ts.isIdentifier(e)) {
      if (env.has(e.text)) return env.get(e.text)!;
      const init = local(e, e.text);
      return init ? text(init, env, depth + 1) : ":p";
    }
    if (ts.isCallExpression(e)) {
      const c = e.expression;
      if (ts.isIdentifier(c) && /^(encodeURIComponent|String)$/.test(c.text) && e.arguments[0]) return text(e.arguments[0], env, depth + 1);
      if (ts.isPropertyAccessExpression(c) && c.expression.kind === ts.SyntaxKind.ThisKeyword && members.has(c.name.text)) {
        const f = members.get(c.name.text)!, r = returned(f);
        return r ? text(r, bind(f, e.arguments, env, depth), depth + 1) : ":p";
      }
    }
    return ":p";
  };
  // The request a function ends in: a workspaceFetch (its method, else GET),
  // an upload (POST), or a helper of the class it hands its verb and path on to.
  const sink = (f: ts.Node, env: Env, depth: number): string | null => {
    if (depth > 6) return null;
    let found: string | null = null;
    (function walk(n: ts.Node): void {
      if (found) return;
      if (ts.isCallExpression(n)) {
        const c = n.expression;
        const name = ts.isIdentifier(c) ? c.text : null;
        if (name && (SINKS.has(name) || UPLOADS.test(name)) && n.arguments[0]) {
          let verb = UPLOADS.test(name) ? "POST" : "GET";
          const init = n.arguments[1];
          if (init && ts.isObjectLiteralExpression(init)) for (const p of init.properties) {
            if (ts.isPropertyAssignment(p) && p.name.getText(sf) === "method") verb = text(p.initializer, env, depth);
            if (ts.isShorthandPropertyAssignment(p) && p.name.text === "method") verb = env.get("method") ?? text(p.name, env, depth);
          }
          verb = verb.toUpperCase();
          if (HTTP.test(verb)) found = `${verb} ${shape(text(n.arguments[0], env, depth).replace(/^\/api\/v1/, ""))}`;
          return;
        }
        if (ts.isPropertyAccessExpression(c) && c.expression.kind === ts.SyntaxKind.ThisKeyword && members.has(c.name.text)) {
          const g = members.get(c.name.text)!;
          found = sink(g.body ?? g, bind(g, n.arguments, env, depth), depth + 1);
          if (found) return;
        }
      }
      n.forEachChild(walk);
    })(f);
    return found;
  };
  const methods = new Map<string, string>();
  for (const [name, f] of members) { const r = sink(f.body ?? f, new Map(), 0); if (r) methods.set(name, r); }
  const direct: Array<{ at: number; request: string }> = [];
  if (!members.size) sf.forEachChild(function walk(n): void {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && SINKS.has(n.expression.text)) {
      const r = sink(n.parent, new Map(), 0);
      if (r && !r.startsWith("GET ")) direct.push({ at: n.getStart(sf), request: r });
    }
    n.forEachChild(walk);
  });
  return { methods, direct };
}

/** A module's UI files that send a write a member is refused, through the
 *  module's own client (`api.updatePart(`) or a workspaceFetch of their own,
 *  with no gate on the way. Reach is followed up the module's own imports to
 *  a file nothing in the module imports: the module's pages, drawn for anyone
 *  its nav lets in. */
export function moduleUiViolations(files: Array<[string, string]>, routes: Map<string, string[]>): Violation[] {
  const out: Violation[] = [];
  const byModule = new Map<string, Array<[string, string]>>();
  for (const [f, s] of files) { const m = /^modules\/([^/]+)\/src\/ui\//.exec(f)?.[1]; if (m) (byModule.get(m) ?? byModule.set(m, []).get(m)!).push([f, s]); }
  const said = (route: string) => (routes.get(route)![0]!.startsWith("capability ") ? routes.get(route)![0]! : `requireRole ${routes.get(route)!.join(", ")}`);
  for (const [, ui] of byModule) {
    const src = new Map(ui);
    const clientMethods = new Map<string, string>();
    const direct = new Map<string, Array<{ at: number; request: string }>>();
    for (const [f, s] of ui) {
      if (!s.includes("workspaceFetch(") && !/\bupload[A-Z]?\w*\(/.test(s)) continue;
      const r = clientRequests(f, s);
      for (const [name, request] of r.methods) if (routes.has(request)) clientMethods.set(name, request);
      const hits = r.direct.filter((d) => routes.has(d.request));
      if (hits.length) direct.set(f, hits);
    }
    if (!clientMethods.size && !direct.size) continue;
    const importers = new Map<string, Set<string>>();
    for (const [f, s] of ui) {
      parse(f, s).forEachChild(function walk(n): void {
        const spec = ts.isImportDeclaration(n) && !n.importClause?.isTypeOnly && ts.isStringLiteral(n.moduleSpecifier) ? n.moduleSpecifier.text
          : ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0]) ? n.arguments[0].text : null;
        const base = spec?.startsWith(".") ? normalize(join(dirname(f), spec.replace(/\.js$/, ""))) : null;
        const to = base ? [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")].find((c) => /\.tsx?$/.test(c) && src.has(c)) : null;
        if (to) (importers.get(to) ?? importers.set(to, new Set()).get(to)!).add(f);
        n.forEachChild(walk);
      });
    }
    // Above the caller only a page-level wrapper closes the way, never an
    // importer's gate for some other control.
    const memo = new Map<string, string | null>();
    const upFrom = (f: string, seen: Set<string>): string | null => {
      if (memo.has(f)) return memo.get(f)!;
      if (seen.has(f)) return null;
      seen.add(f);
      let found: string | null = null;
      if (!PAGE_GATE.test(src.get(f) ?? "")) {
        const by = [...(importers.get(f) ?? [])];
        if (!by.length) found = f;
        for (const b of by) { const via = upFrom(b, seen); if (via) { found = via; break; } }
      }
      memo.set(f, found);
      return found;
    };
    // The caller asks the gate itself, or says on a GATED-BY: line what draws it only for those allowed.
    const openPath = (f: string): string | null => (GATE.test(src.get(f) ?? "") ? null : upFrom(f, new Set()));
    for (const [f, s] of ui) {
      if (/\/ui\/api\.ts$/.test(f)) continue;
      const calls: Array<{ at: number; what: string; route: string }> = [];
      for (const [name, route] of clientMethods) {
        const m = new RegExp(`\\b\\w+\\.${name}!?\\s*\\(`).exec(s);
        if (m) calls.push({ at: m.index, what: `.${name}`, route });
      }
      for (const d of direct.get(f) ?? []) calls.push({ at: d.at, what: "workspaceFetch", route: d.request });
      if (!calls.length) continue;
      const via = openPath(f);
      if (!via) continue;
      for (const c of calls) out.push({ file: f, line: s.slice(0, c.at).split("\n").length, what: `${c.what} is ${c.route}, refused to a ${PROBE_ROLE} (${said(c.route)}), and a ${PROBE_ROLE} reaches it with no gate (via ${via})` });
    }
  }
  return out;
}

export function check(): Violation[] {
  const read = (fs: string[]) => fs.map((f) => [f, readFileSync(f, "utf8")] as [string, string]);
  const modules = repoFiles(["modules"]);
  const moduleApi = read(notTests(modules.filter((f) => /^modules\/[^/]+\/src\/api\//.test(f))));
  const holds = memberHoldings(read([...modules.filter((f) => /^modules\/[^/]+\/src\/module\.ts$/.test(f)), "api/src/platform/platform-actions.ts", "api/src/platform/capability-grants.ts"]), MEMBER_DEFAULT_CAPABILITIES);
  const routes = memberRefusedRoutes([...read(notTests(repoFiles(["api/src"]))), ...moduleApi], { prefixOf: modulePrefixes(moduleApi), memberHolds: holds });
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
    // The client a host hands a shared package (<PlatformWebProvider api={{…}}>)
    // is wiring, not a control: the package's own control is judged where it draws.
    const handedOn: Array<[number, number]> = [];
    if (text.includes("api={{")) {
      const sf = parse(file, text);
      const visit = (n: ts.Node) => {
        if (ts.isJsxAttribute(n) && n.name.getText(sf) === "api" && n.initializer) handedOn.push([n.initializer.pos, n.initializer.end]);
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    for (const [name, route] of methods) {
      // A call draws or sends it; a reference handed on (the provider's client) does not.
      const re = new RegExp(`\\bapi\\.${name}!?\\s*\\(`, "g");
      let at = -1;
      for (let m = re.exec(text); m; m = re.exec(text)) if (!handedOn.some(([a, b]) => m!.index >= a && m!.index < b)) { at = m.index; break; }
      if (at < 0) continue;
      const via = openPath(file, new Set());
      if (!via) continue;
      out.push({ file, line: text.slice(0, at).split("\n").length, what: `api.${name} is ${route}, refused to a ${PROBE_ROLE} (${routes.get(route)![0]!.startsWith("capability ") ? routes.get(route)![0] : `requireRole ${routes.get(route)!.join(", ")}`}), and a ${PROBE_ROLE} reaches it with no gate (via ${via})` });
    }
  }
  out.push(...moduleUiViolations(read(notTests(modules.filter((f) => /^modules\/[^/]+\/src\/ui\//.test(f)))), routes));
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
