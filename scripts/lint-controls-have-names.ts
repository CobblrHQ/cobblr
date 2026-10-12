#!/usr/bin/env tsx
// Every control names itself: an icon-only button or link carries an aria-label and a title that start with the same word, and a label wraps its control or points at it with htmlFor.
//
// THE BUG THIS PREVENTS. The sidebar's row menus ("Arrange Board Projects")
// were a lone "…" icon with an aria-label and no tooltip, so a person saw a
// glyph and nothing to say what it did (#5918, a staging nightly,
// 2026-10-12). The same day a pattern's Status, Priority and task-size
// selects had EMPTY accessible names: the caption sat in a <label> beside the
// select, wrapping nothing and pointing at nothing, so a screen reader and a
// voice command could not tell Status from Priority (#5912). Marking a
// pattern Done uses up its yarn, so that unnamed control was a consequential
// one. Two hundred and fifty icon buttons had one of the pair and not the
// other.
//
// THE RULE.
//   1. A <button>, <a>, <Link> or <NavLink> whose only content is icons
//      (components imported from lucide-react, or named Icon / ...Icon, alone
//      or as the two arms of a ?:), or icons beside words a phone never sees
//      (a span "hidden sm:inline" or "max-sm:hidden") or only a screen
//      reader gets ("sr-only"), carries BOTH an accessible name. So does a
//      span or div with role="button" around icons. Each of the last two
//      was missed once (#6032).
//      (aria-label or aria-labelledby) AND a title, its tooltip. When both
//      are written out, they start with the same word: the tooltip a sighted
//      person reads and the name a voice command says ("click Remove") name
//      the same action. The rest of the tooltip may say more ("Clear (Esc)"
//      for "Clear search"); a ?: counts when any of its arms agree, so
//      "Undo" beside "Undo: Moved a shelf" / "Nothing to undo" passes.
//   2. A <label> wraps its control or points at it (htmlFor). One that holds
//      only text and points nowhere labels nothing.
//   3. A field (input, select, textarea, NumberField) has a name: its own
//      aria-label, title or placeholder, an id a label points at, a <label>
//      around it, or a wrapper that takes the caption (<Field label=...>)
//      and draws a <label>. A wrapper defined in the same file that draws
//      only a caption is not trusted: the station settings' Field was one.
// A genuine exception says why on the element or within the two lines above:
//   // NAME-OK: <why>      (or {/* NAME-OK: <why> */} inside JSX)
//
// THE BOUNDARY, AND WHICH FALSE POSITIVE DREW IT. A tile button wrapping
// <EntityTile title=...> is a self-closing component with no text written
// beside it, and looked icon-only on the first draft; the tile draws its
// name as text. So only icon components count as icons, and anything else
// (a photo, a tile, an avatar) is judged in the browser by the walk's
// controlsNamed check, which reads the text a person actually sees. An
// element with a {...spread} is skipped: its name may arrive in the spread.
// A label around {children} or {trigger} is a field wrapper whose control
// arrives from its caller, and was flagged on the first draft; a value
// handed in that way counts as the control unless its name reads as words
// ({label}, {def.title}).
// A name or title built from an expression the lint cannot read (a
// variable, a call) is not compared, only required.
//
// PROVE IT RED: on main before #5918 it named 400 places, NavSplitRow.tsx's
// Arrange button and ProjectDetailPage.tsx's Labelled caption among them.
//
//   npx tsx scripts/lint-controls-have-names.ts   (pnpm lint controls-have-names)
import { readFileSync } from "node:fs";
import ts from "typescript";
import { repoFiles } from "./lib/repo-files.js";

const ROOTS = ["web/src", "modules", "packages/platform-web/src"];
const PRESSABLE = new Set(["button", "a", "Link", "NavLink"]);
/** What a label may hold and still hold only words. */
const TEXT_TAGS = new Set(["span", "b", "strong", "em", "br", "small", "i", "abbr", "code", "sup", "sub"]);
const NAME_OK = /NAME-OK: \S/;
/** Fields that need a name of their own. */
const FIELDS = new Set(["input", "select", "textarea", "NumberField"]);
/** A name that reads as words, not a control: {label}, {def.title}. */
const TEXTY_NAME = /(label|title|name|text|caption|heading|hint)$/i;

/** A value handed into a label from outside ({children}, {trigger}): it may
 *  be the control, so the label is taken at its word. */
function passedIn(e: ts.Expression): boolean {
  if (ts.isIdentifier(e)) return !TEXTY_NAME.test(e.text);
  if (ts.isPropertyAccessExpression(e)) return !TEXTY_NAME.test(e.name.text);
  return false;
}

interface Violation {
  file: string;
  line: number;
  what: string;
}

/** The first word of each string an expression can be, lowercased, or null
 *  when the expression is one the lint cannot read. */
export function firstWords(e: ts.Expression | undefined): Set<string> | null {
  if (!e) return null;
  if (ts.isParenthesizedExpression(e)) return firstWords(e.expression);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return new Set([firstWord(e.text)]);
  if (ts.isTemplateExpression(e)) return e.head.text.trim() ? new Set([firstWord(e.head.text)]) : null;
  if (ts.isConditionalExpression(e)) {
    const a = firstWords(e.whenTrue), b = firstWords(e.whenFalse);
    return a && b ? new Set([...a, ...b]) : null;
  }
  return null;
}

function firstWord(s: string): string {
  return (s.trim().split(/\s+/)[0] ?? "").toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

function valueOf(a: ts.JsxAttribute | undefined): ts.Expression | undefined {
  const init = a?.initializer;
  if (!init) return undefined;
  if (ts.isStringLiteral(init)) return init;
  if (ts.isJsxExpression(init)) return init.expression;
  return undefined;
}

export function check(file: string, src: string): Violation[] {
  if (!/<(button|a|Link|NavLink|label|input|select|textarea|NumberField)\b|role="button"/.test(src)) return [];
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const icons = new Set<string>();
  for (const s of sf.statements) {
    const b = ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) && s.moduleSpecifier.text === "lucide-react" ? s.importClause?.namedBindings : undefined;
    if (b && ts.isNamedImports(b)) for (const el of b.elements) icons.add(el.name.text);
  }
  const isIconTag = (t: string) => icons.has(t) || /^(Icon|[A-Z]\w*Icon)$/.test(t);
  // Words a phone never sees: a span shown only from a breakpoint up
  // ("hidden sm:inline") or hidden below one ("max-sm:hidden"). On a phone
  // its control is an icon, and needs the pair like any other (#5918: the
  // locations page's Place items, Export and Import).
  // Words only a screen reader gets: "sr-only" / "visually-hidden". They
  // name the control and leave a person looking at a bare glyph (#6032).
  const isScreenReaderOnly = (n: ts.Node): boolean => {
    if (!ts.isJsxElement(n)) return false;
    const cls = n.openingElement.attributes.properties.find((a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText(sf) === "className");
    return !!cls?.initializer && ts.isStringLiteral(cls.initializer) && /(^|\s)(sr-only|visually-hidden)(\s|$)/.test(cls.initializer.text);
  };
  const isNarrowHidden = (n: ts.Node): boolean => {
    if (ts.isJsxExpression(n) && n.expression) return isNarrowHidden(n.expression);
    if (ts.isParenthesizedExpression(n)) return isNarrowHidden(n.expression);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return isNarrowHidden(n.right);
    if (!ts.isJsxElement(n)) return false;
    const cls = n.openingElement.attributes.properties.find((a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText(sf) === "className");
    const text = cls?.initializer && ts.isStringLiteral(cls.initializer) ? cls.initializer.text : "";
    return /(^|\s)hidden(\s|$)/.test(text) && /(^|\s)(sm|md|lg):(inline|block|flex|inline-flex|inline-block)(\s|$)/.test(text) || /(^|\s)max-(sm|md|lg):hidden(\s|$)/.test(text);
  };
  const isIcon = (n: ts.Node): boolean => {
    if (ts.isJsxSelfClosingElement(n)) return isIconTag(n.tagName.getText(sf));
    if (ts.isParenthesizedExpression(n)) return isIcon(n.expression);
    if (ts.isJsxExpression(n)) return !!n.expression && isIcon(n.expression);
    if (ts.isConditionalExpression(n)) return isIcon(n.whenTrue) && isIcon(n.whenFalse);
    return false;
  };
  // Wrappers this file defines that draw a caption but no <label>.
  const captionOnly = new Set<string>();
  for (const s of sf.statements) if (ts.isFunctionDeclaration(s) && s.name && /^[A-Z]/.test(s.name.text) && !/<label\b/.test(s.getText(sf))) captionOnly.add(s.name.text);
  const lines = src.split("\n");
  const excused = (node: ts.Node) => {
    const at = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
    return NAME_OK.test(node.getText(sf).split("\n")[0] ?? "") || lines.slice(Math.max(0, at - 2), at).some((l) => NAME_OK.test(l));
  };
  const out: Violation[] = [];
  const flag = (node: ts.Node, what: string) => {
    if (!excused(node)) out.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, what });
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node)) {
      const o = node.openingElement;
      const tag = o.tagName.getText(sf);
      const props = o.attributes.properties;
      const attr = (k: string) => props.find((a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText(sf) === k);
      const spread = props.some((a) => ts.isJsxSpreadAttribute(a));
      // A span or a div that says it is a button is one (the AI-order grip, #6032).
      const roleButton = (() => {
        const r = attr("role")?.initializer;
        return !!r && ts.isStringLiteral(r) && r.text === "button";
      })();
      if ((PRESSABLE.has(tag) || roleButton) && !spread) {
        const kids = node.children.filter((c) => !(ts.isJsxText(c) && !c.text.trim()));
        if (kids.length && kids.some(isIcon) && kids.every((k) => isIcon(k) || isNarrowHidden(k) || isScreenReaderOnly(k))) {
          const label = attr("aria-label"), title = attr("title");
          if (!label && !attr("aria-labelledby")) flag(node, `an icon-only <${tag}> has no aria-label${title ? "" : " and no title"}: say what it does, in both`);
          else if (!title) flag(node, `an icon-only <${tag}> has an aria-label but no title: a person sees only the icon, so give it the tooltip too`);
          else if (label) {
            const a = firstWords(valueOf(label)), t = firstWords(valueOf(title));
            if (a && t && ![...a].some((w) => t.has(w))) flag(node, `an icon-only <${tag}>'s aria-label and title name different actions (${[...a].join("/")} vs ${[...t].join("/")}): start both with the same word`);
          }
        }
      }
      if (FIELDS.has(tag) && !spread) checkField(node.openingElement, node);
      if (tag === "label" && !attr("htmlFor") && !spread) {
        let holdsControl = false;
        const look = (n: ts.Node) => {
          if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
            const t = (ts.isJsxElement(n) ? n.openingElement : n).tagName.getText(sf);
            if (!TEXT_TAGS.has(t)) holdsControl = true;
          } else if (ts.isJsxExpression(n) && n.expression && passedIn(n.expression)) holdsControl = true;
          if (!holdsControl) ts.forEachChild(n, look);
        };
        node.children.forEach(look);
        if (!holdsControl) flag(node, "a <label> that wraps no control and has no htmlFor labels nothing: wrap the control, or give it htmlFor and the control an id");
      }
    }
    if (ts.isJsxSelfClosingElement(node) && FIELDS.has(node.tagName.getText(sf))) checkField(node, node);
    ts.forEachChild(node, visit);
  };
  // A field names itself (aria-label, aria-labelledby, a title, a
  // placeholder), is pointed at (an id a label's htmlFor can name), or sits
  // inside a <label>. NumberField takes its name as `label`.
  function checkField(o: ts.JsxOpeningElement | ts.JsxSelfClosingElement, node: ts.Node) {
    const tag = o.tagName.getText(sf);
    const props = o.attributes.properties;
    if (props.some((a) => ts.isJsxSpreadAttribute(a))) return;
    const has = (k: string) => props.some((a) => ts.isJsxAttribute(a) && a.name.getText(sf) === k);
    const type = props.find((a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText(sf) === "type")?.initializer;
    if (type && ts.isStringLiteral(type) && /^(hidden|submit|button|reset|image|file)$/.test(type.text)) return;
    if (["aria-label", "aria-labelledby", "title", "placeholder", "id", "label", "ariaLabel"].some(has)) return;
    for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
      if (ts.isJsxElement(p) && p.openingElement.tagName.getText(sf) === "label") return;
      // A field wrapper that takes the caption (<Field label="Name">) labels
      // what it wraps, unless this file defines it and it draws no <label>
      // (the station settings' Field was a div with a caption above, #5918).
      if (ts.isJsxElement(p) && /^[A-Z]/.test(p.openingElement.tagName.getText(sf)) && !captionOnly.has(p.openingElement.tagName.getText(sf)) && p.openingElement.attributes.properties.some((a) => ts.isJsxAttribute(a) && a.name.getText(sf) === "label")) return;
      if (ts.isFunctionLike(p)) break;
    }
    flag(node, `a <${tag}> with no name: give it an aria-label (or wrap it in its <label>)`);
  }
  visit(sf);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations: Violation[] = [];
  for (const file of repoFiles(ROOTS).filter((f: string) => f.endsWith(".tsx") && !/\.test\.tsx$/.test(f))) violations.push(...check(file, readFileSync(file, "utf8")));
  if (violations.length) {
    console.error(`lint:controls-have-names - ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
    console.error("Name the control. A genuine exception says why: // NAME-OK: <why>");
    process.exit(1);
  }
  console.log("lint:controls-have-names OK");
}
