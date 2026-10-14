#!/usr/bin/env tsx
// Every place a person chooses a location uses the platform's location picker, with no prop that narrows what it offers.
//
// THE BUG THIS PREVENTS. The scan camera passed kind="area" to the chip
// picker, a flat wrap of areas only, and the owner could not choose a shelf or
// bin inside a room (#6438). The same sweep found eight forms drawing their own
// flat <select> of locations, with no rooms, shelves or bins in it. The
// platform standardised on one picker once (e231fd2d1e, location:one-picker in
// scripts/capabilities.ts), and it drifted back twice.
//
// THE RULE.
//   1. The pickers are LocationTreePicker and LocationChipPicker (web/src) and
//      LocationPicker (@cobblr/platform-web, the host's tree picker for a
//      module UI). Each takes exactly the props listed in PICKERS below, and
//      its Props interface must match that list: a new prop is a decision
//      written here with its reason, never a quiet addition. The only props
//      that narrow are the ones that must: excludeId and excludeSubtreeOf (a
//      place cannot be its own parent), and onPickHolder (Move everything's
//      destination offers the things that hold things too).
//   2. Every render of a picker passes only those props, and no spread.
//   3. A <select> whose value names a location or place is a hand-made
//      chooser: it fails, wherever it is.
//   4. No generic chooser (an EditableCell, a choice field) is handed a list
//      of locations as its options: the parts table edited a row's Location
//      that way, as a flat list.
//   5. A component named for picking a place (FooPlacePicker, a
//      LocationChooser, a PlacePickList) is declared only in the pickers' own
//      files. The Station had its own PlacePicker, a flat list indented by
//      depth and cut off at 40, and platform-web a PlacePickList for Move to.
//
// THE BOUNDARY. Only a select's value= is read: its label and handler name
// other things ("Pick-and-place machine" in Builds, a router's
// location.pathname in the settings jump list). A list of locations drawn for another purpose (the Locations
// page itself, a floor plan, a breadcrumb) is not a chooser and is not judged.
// A hand-made chip list over locations is not detected yet: the chip picker's
// own shape is chips, so nothing tells the two apart line by line. A <select>
// whose words name a place for another reason opts out with
// `// location-select-ok: <why>` on the line above it.
//
//   npx tsx scripts/lint-one-location-picker.ts   (pnpm lint one-location-picker)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isEmbeddedPayload } from "./lib/embedded-payloads.mjs";

/** Where the rule bites. Keep it narrow: a lint over the whole repo judges
 *  files whose authors never heard of it. */
const ROOTS = ["web/src", "modules", "packages/platform-web/src"];

/** One offending place. `line` is 1-based for a clickable path:line. */
interface Violation {
  file: string;
  line: number;
  what: string;
}

function* walk(dir: string): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    // An embedded payload (a base64 build) holds no code to judge and is megabytes.
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !isEmbeddedPayload(p)) yield p;
  }
}

/** Each picker, the file that declares its props, and the props it takes. */
const PICKERS: Record<string, { file: string; iface: RegExp; props: string[] }> = {
  LocationTreePicker: {
    file: "web/src/components/LocationTreePicker.tsx",
    iface: /^interface Props \{$/m,
    props: ["value", "onChange", "excludeId", "excludeSubtreeOf", "label", "placeholder", "triggerLabel", "description", "noneLabel", "className", "size", "thing", "onPlaced", "onPickHolder", "pickedHolder"],
  },
  LocationChipPicker: {
    file: "web/src/components/LocationChipPicker.tsx",
    iface: /^interface Props \{$/m,
    props: ["value", "onChange", "excludeId", "className", "suggestion", "withShortcuts"],
  },
  LocationChips: {
    file: "packages/platform-web/src/context.tsx",
    iface: /^export interface LocationChipsProps \{$/m,
    props: ["value", "onChange", "withShortcuts", "className"],
  },
  LocationPicker: {
    file: "packages/platform-web/src/context.tsx",
    iface: /^export interface LocationPickerProps \{$/m,
    props: ["value", "onChange", "label", "placeholder", "noneLabel", "size", "className", "onPickHolder", "pickedHolder"],
  },
};

const OWNER_FILES = new Set(Object.values(PICKERS).map((p) => p.file));

/** The top-level keys of the interface that starts at `start`. */
function interfaceKeys(src: string, start: RegExp): string[] | null {
  const m = start.exec(src);
  if (!m) return null;
  const body = src.slice(m.index + m[0].length, src.indexOf("\n}", m.index));
  return [...body.matchAll(/^ {2}(?:readonly )?([A-Za-z_]\w*)\??:/gm)].map((k) => k[1]!);
}

/** The text of every opening tag of `name`, braces balanced, with its line. */
function openingTags(src: string, name: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  const re = new RegExp(`<${name}(?![A-Za-z0-9_])`, "g");
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let i = m.index + m[0].length;
    let depth = 0;
    let quote: string | null = null;
    for (; i < src.length; i++) {
      const c = src[i]!;
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    out.push({ line: src.slice(0, m.index).split("\n").length, text: src.slice(m.index + m[0].length, i) });
  }
  return out;
}

/** An opening tag's attribute names: what is inside {…} and quotes removed first. */
function attributes(tag: string): string[] {
  let flat = "";
  let depth = 0;
  for (const c of tag) {
    if (c === "{") depth++;
    if (depth === 0) flat += c;
    if (c === "}") depth--;
  }
  flat = flat.replace(/"[^"]*"|'[^']*'/g, '""');
  return [...flat.matchAll(/(?:^|\s)([A-Za-z_][\w-]*)(?==|\s|\/|$)/g)].map((m) => m[1]!);
}

/** The expression a tag's value= holds: what the select chooses. Its label
 *  and handler are not judged: "Pick-and-place machine" names no location. */
function valueOf(tag: string): string {
  const at = tag.search(/(?:^|\s)value=/);
  if (at < 0) return "";
  const start = tag.indexOf("=", at) + 1;
  if (tag[start] !== "{") return tag.slice(start).split(/\s/)[0] ?? "";
  let depth = 0;
  for (let i = start; i < tag.length; i++) {
    if (tag[i] === "{") depth++;
    if (tag[i] === "}" && --depth === 0) return tag.slice(start + 1, i);
  }
  return "";
}

const NAMES_A_PLACE = /\b(?:locs?|locations?|places?)(?:Id|_id|s)?\b|[a-z](?:Loc|Location|Place)(?:s|Id)?\b|\bnew_location_id\b/;

/** The check. Return every violation in one file; an empty array is a pass. */
function check(file: string, src: string): Violation[] {
  const out: Violation[] = [];
  const lines = src.split("\n");
  for (const [name, p] of Object.entries(PICKERS)) {
    for (const tag of openingTags(src, name)) {
      if (/\{\s*\.\.\./.test(tag.text)) out.push({ file, line: tag.line, what: `<${name}> takes a spread: name each prop, so none narrows it unseen` });
      for (const a of attributes(tag.text)) {
        if (a === "key") continue;
        if (!p.props.includes(a)) out.push({ file, line: tag.line, what: `<${name}> given ${a}, which it does not take: no prop narrows a location picker` });
      }
    }
  }
  if (!OWNER_FILES.has(file)) {
    for (const m of src.matchAll(/^(?:export )?(?:function|const) (\w*(?:Place|Location)(?:Picker|Chooser|Select|PickList))\b/gm)) {
      out.push({ file, line: src.slice(0, m.index).split("\n").length, what: `${m[1]} is a second location picker: use the platform's` });
    }
  }
  lines.forEach((line, i) => {
    if (/\boptions=\{\s*\(?\s*(?:locs?|locations?|places?)[A-Z.?(\s]/.test(line) || /\boptions=\{\s*(?:loc|location|place)Options\b/.test(line))
      out.push({ file, line: i + 1, what: "a list of locations handed to a generic chooser as options: a flat list with no rooms, shelves or bins in it" });
  });
  for (const tag of openingTags(src, "select")) {
    if (!NAMES_A_PLACE.test(valueOf(tag.text).replace(/\blocation\.(?:pathname|search|hash)\b/g, ""))) continue;
    if (/location-select-ok: \S/.test(lines[tag.line - 2] ?? "")) continue;
    out.push({ file, line: tag.line, what: "a <select> of locations drawn by hand: a flat list with no rooms, shelves or bins in it" });
  }
  return out;
}

const violations: Violation[] = [];
for (const [name, p] of Object.entries(PICKERS)) {
  const keys = interfaceKeys(readFileSync(p.file, "utf8"), p.iface);
  if (!keys) {
    violations.push({ file: p.file, line: 1, what: `${name}'s props interface was not found: update PICKERS` });
    continue;
  }
  for (const k of keys.filter((k) => !p.props.includes(k))) violations.push({ file: p.file, line: 1, what: `${name} declares ${k}, which PICKERS does not list: a new prop is a decision written there with its reason` });
  for (const k of p.props.filter((k) => !keys.includes(k))) violations.push({ file: p.file, line: 1, what: `PICKERS lists ${k} for ${name}, which it no longer takes: drop it` });
}
for (const root of ROOTS) for (const file of walk(root)) violations.push(...check(file, readFileSync(file, "utf8")));

if (violations.length) {
  console.error(`lint:one-location-picker - ${violations.length} violation(s):`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.what}`);
  console.error("use LocationTreePicker or LocationChipPicker in web/src, LocationPicker from @cobblr/platform-web in a module UI");
  process.exit(1);
}
console.log(`lint:one-location-picker OK`);
