#!/usr/bin/env tsx
// A hand-listed module mock defines every name imported by the code under test.
//
// THE BUG THIS PREVENTS. A share-sync mock omitted queueShareOpIn when
// share-offers began importing it (2026-11-01).
//
// THE RULE. Check runtime import names in the test, its imported files and
// their relative imports one level down. Resolve relative paths from each
// importer. Variable factories and objects with spreads count as complete.
// A mock-import-names-exempt: name, name; reason comment immediately above
// a mock records specific omitted names, so future imports still get checked.
// Exempt names must still be imported in that graph; removed imports lose theirs.
//
// THE BOUNDARY. Whole-module stand-ins keep database pools out of unit tests;
// requiring importOriginal would defeat that isolation. Mocked modules are
// replaced, so their own imports are outside the tested graph. Type imports
// and namespace bindings do not request a named runtime export.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";

const ROOTS = ["api", "modules", "web/src", "packages", "ops-console/src", "scripts"];
type Load = (file: string) => string | undefined;
interface Finding { file: string; line: number; module: string; missing: string[]; stale?: string[] }
interface Import { module: string; names: string[] }

function parse(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function imports(tree: ts.SourceFile): Import[] {
  const result: Import[] = [];
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (clause?.isTypeOnly) return;
      const names = clause?.name ? ["default"] : [];
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          if (!element.isTypeOnly) names.push((element.propertyName || element.name).text);
        }
      }
      result.push({ module: node.moduleSpecifier.text, names });
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteral(argument)) result.push({ module: argument.text, names: [] });
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return result;
}

function moduleKey(file: string, specifier: string): string {
  return specifier.startsWith(".") ? resolve(dirname(file), specifier).replace(/\.(?:[cm]?[jt]sx?)$/, "") : specifier;
}

function loadModule(key: string, load: Load): { file: string; source: string } | undefined {
  if (!isAbsolute(key)) return;
  const candidates = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"].map((extension) => key + extension);
  candidates.push(join(key, "index.ts"), join(key, "index.tsx"));
  for (const file of candidates) {
    const source = load(file);
    if (source !== undefined) return { file, source };
  }
  return;
}

function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node)) node = node.expression;
  return node;
}

function factoryObjects(factory: ts.Expression): ts.ObjectLiteralExpression[] {
  factory = unwrap(factory);
  if (!ts.isArrowFunction(factory) && !ts.isFunctionExpression(factory)) return [];
  if (!ts.isBlock(factory.body)) {
    const body = unwrap(factory.body);
    return ts.isObjectLiteralExpression(body) ? [body] : [];
  }
  const objects: ts.ObjectLiteralExpression[] = [];
  function visit(node: ts.Node): void {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) {
      const value = unwrap(node.expression);
      if (ts.isObjectLiteralExpression(value)) objects.push(value);
    }
    ts.forEachChild(node, visit);
  }
  visit(factory.body);
  return objects;
}

export function checkMockImports(file: string, source: string, load: Load, dependenciesOf = (path: string, text: string) => imports(parse(path, text))): Finding[] {
  const tree = parse(file, source);
  const mocks: { module: string; line: number; objects: ts.ObjectLiteralExpression[]; exempt: Set<string> }[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "vi" && node.expression.name.text === "mock") {
      const [specifier, factory] = node.arguments;
      if (specifier && ts.isStringLiteral(specifier) && factory) {
        const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line;
        const above = source.split("\n")[line - 1] || "";
        const exemption = /^\s*\/\/\s*mock-import-names-exempt:\s*([\w$]+(?:\s*,\s*[\w$]+)*);\s*\S.*$/.exec(above);
        mocks.push({ module: specifier.text, line: line + 1, objects: factoryObjects(factory), exempt: new Set(exemption?.[1]?.split(/\s*,\s*/) || []) });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  if (!mocks.length) return [];
  const mocked = new Set(mocks.map((mock) => moduleKey(file, mock.module)));
  const needed = new Map<string, Set<string>>();
  const visited = new Map<string, number>();
  function collect(importer: string, dependencies: Import[], depth: number): void {
    for (const dependency of dependencies) {
      const key = moduleKey(importer, dependency.module);
      const names = needed.get(key) || new Set<string>();
      dependency.names.forEach((name) => names.add(name));
      needed.set(key, names);
      if (depth === 0 || mocked.has(key) || (visited.get(key) || 0) >= depth) continue;
      visited.set(key, depth);
      const loaded = loadModule(key, load);
      if (loaded) collect(loaded.file, dependenciesOf(loaded.file, loaded.source), depth - 1);
    }
  }
  collect(file, imports(tree), 2);
  const findings: Finding[] = [];
  for (const mock of mocks) {
    const required = needed.get(moduleKey(file, mock.module)) || new Set<string>();
    const missing = new Set<string>();
    for (const object of mock.objects) {
      if (object.properties.some(ts.isSpreadAssignment)) continue;
      const keys = new Set(object.properties.flatMap((property) => {
        const name = property.name;
        if (!name) return [];
        if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return [name.text];
        if (ts.isComputedPropertyName(name) && ts.isStringLiteral(name.expression)) return [name.expression.text];
        return [];
      }));
      for (const name of required) if (!keys.has(name) && !mock.exempt.has(name)) missing.add(name);
    }
    const stale = [...mock.exempt].filter((name) => !required.has(name)).sort();
    if (missing.size || stale.length) findings.push({
      file, line: mock.line, module: mock.module, missing: [...missing].sort(),
      ...(stale.length ? { stale } : {}),
    });
  }
  return findings;
}

function* walk(dir: string): Generator<string> {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || ["node_modules", "dist", "build", "fixtures", "__fixtures__"].includes(entry.name)) continue;
    const file = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(file);
    else if (/\.(?:test|spec)\.[jt]sx?$/.test(file)) yield file;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const cache = new Map<string, string | undefined>();
  const load: Load = (file) => {
    if (isEmbeddedPayload(relative(process.cwd(), file))) return undefined;
    if (!cache.has(file)) {
      try { cache.set(file, statSync(file).isFile() ? readFileSync(file, "utf8") : undefined); } catch { cache.set(file, undefined); }
    }
    return cache.get(file);
  };
  const dependencies = new Map<string, Import[]>();
  const dependenciesOf = (file: string, source: string): Import[] => {
    if (!dependencies.has(file)) dependencies.set(file, imports(parse(file, source)));
    return dependencies.get(file)!;
  };
  const findings: Finding[] = [];
  const files = process.argv.slice(2);
  for (const file of files.length ? files : ROOTS.flatMap((root) => [...walk(root)])) {
    const source = load(resolve(file)) || "";
    if (source.includes("mock")) findings.push(...checkMockImports(file, source, load, dependenciesOf));
  }
  for (const finding of findings) {
    const location = `${finding.file}:${finding.line} ${finding.module}`;
    if (finding.missing.length) console.error(`${location} mock is missing: ${finding.missing.join(", ")}`);
    if (finding.stale?.length) console.error(`${location} mock has stale exemption names: ${finding.stale.join(", ")}`);
  }
  if (findings.length) {
    console.error(`lint:mock-import-names: ${findings.length} invalid mock(s). Remove stale exemption names. Define missing names, or record mock-import-names-exempt: name, name; reason immediately above the mock.`);
    process.exitCode = 1;
  } else console.log("lint:mock-import-names OK");
}
