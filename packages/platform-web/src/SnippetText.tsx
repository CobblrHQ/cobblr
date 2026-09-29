// The line a search matched on, with the searched words marked.
//
// A result found inside a record's words (a pattern's PDF, its notes) rather
// than its name needs to say why it is there: "Baby turtles" under a search
// for "magic ring" reads as a wrong answer until the line shows the words.
// One renderer, so the palette, the search page and a table's own search mark
// a match the same way.

/** `text` with each case-insensitive occurrence of `q` marked. */
export function SnippetText({ text, q }: { text: string; q: string }) {
  const needle = q.trim().toLowerCase();
  if (!needle) return <>{text}</>;
  const parts: Array<{ s: string; hit: boolean }> = [];
  const lower = text.toLowerCase();
  let at = 0;
  while (at < text.length) {
    const i = lower.indexOf(needle, at);
    if (i < 0) {
      parts.push({ s: text.slice(at), hit: false });
      break;
    }
    if (i > at) parts.push({ s: text.slice(at, i), hit: false });
    parts.push({ s: text.slice(i, i + needle.length), hit: true });
    at = i + needle.length;
  }
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? (
          <mark key={i} className="rounded-sm bg-amber-100 dark:bg-amber-900/50 text-inherit px-0.5">
            {p.s}
          </mark>
        ) : (
          <span key={i}>{p.s}</span>
        ),
      )}
    </>
  );
}
