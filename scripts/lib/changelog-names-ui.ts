// The pure half of lint:changelog-names-ui, importable by its test: does a
// feature entry that names a control ship with a change that can carry one?
// The vocabulary, the UI paths and the opt-out all live here. Nothing reads
// git, argv or credentials at module scope; that is what keeps it importable.

/** Things a person presses. A word here is a claim that a control exists. */
const CONTROL_WORDS = ["button", "sheet", "menu", "picker", "tab", "toggle", "card", "chip", "link"];
const CONTROL_RE = new RegExp(`\\b(${CONTROL_WORDS.join("|")})s?\\b`, "i");

/** Where a control can ship. A change that names one must touch one of these. */
const UI_PATHS: Array<{ label: string; test: (f: string) => boolean }> = [
  { label: "web/src/**", test: (f) => /^web\/src\//.test(f) },
  { label: "modules/*/src/ui/**", test: (f) => /^modules\/[^/]+\/src\/ui\//.test(f) },
  { label: "a bundle manifest (bundles/*.json)", test: (f) => /^bundles\/[^/]+\.json$/.test(f) },
];

/** The opt-out, written in the entry: `ui: none (<reason>)`. */
const OPT_OUT_RE = /^\s*ui:\s*none\s*\((.+)\)\s*$/m;

/** One offending place. `line` is 1-based for a clickable path:line. */
export interface Violation {
  file: string;
  line: number;
  what: string;
}

/** The check, pure: the entry's text and the paths its change touched. */
export function check(file: string, src: string, changedPaths: readonly string[]): Violation[] {
  const fm = src.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
  const type = fm.match(/^type:\s*(\S+)/m)?.[1] ?? "";
  if (type !== "feature") return [];
  if (OPT_OUT_RE.test(src)) return [];
  if (UI_PATHS.some((p) => changedPaths.some(p.test))) return [];
  // Scan the prose and the docs section, not the frontmatter: a docs_target
  // heading that happens to say "Buttons" is a pointer, not a claim.
  const head = src.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)?.[0] ?? "";
  const bodyStartLine = head.split("\n").length;
  const lines = src.slice(head.length).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]?.match(CONTROL_RE);
    if (!m) continue;
    return [
      {
        file,
        line: bodyStartLine + i,
        what:
          `a feature entry names a "${m[1]!.toLowerCase()}" but this change touches no path where one can ship ` +
          `(looked for ${UI_PATHS.map((p) => p.label).join(", ")}). Ship the control in the same change, ` +
          `or say why it already exists: a line "ui: none (<reason>)" in the entry.`,
      },
    ];
  }
  return [];
}

