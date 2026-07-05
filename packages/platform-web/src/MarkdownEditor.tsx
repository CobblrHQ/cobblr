// Markdown-first editor for `richtext` fields: a Write/Preview split with a small
// formatting toolbar that inserts Markdown around the selection. Storage stays a
// plain Markdown string (no HTML), so this can later be swapped for a WYSIWYG
// (tiptap) without a data migration. Controlled: `value` + `onChange`; the detail
// panel passes an `onBlur` to commit, the create form wires `onChange` live.
import { useRef, useState, type ReactNode } from "react";
import { Markdown } from "./Markdown";

export function MarkdownEditor({
  value,
  onChange,
  onBlur,
  placeholder = "Write Markdown — **bold**, _italic_, `code`, - lists, [links](https://…)",
  minRows = 6,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  minRows?: number;
  ariaLabel?: string;
}) {
  const [tab, setTab] = useState<"write" | "preview">("write");
  const ref = useRef<HTMLTextAreaElement>(null);

  // Wrap the current selection in `before…after` (e.g. **bold**), keeping the
  // selected text selected inside the new markers.
  function wrap(before: string, after: string = before) {
    const el = ref.current;
    if (!el) return;
    const s = el.selectionStart;
    const e = el.selectionEnd;
    const v = el.value;
    const next = v.slice(0, s) + before + v.slice(s, e) + after + v.slice(e);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = s + before.length;
      el.selectionEnd = e + before.length;
    });
  }

  // Prefix the line the caret is on (headings, list items).
  function prefixLine(prefix: string) {
    const el = ref.current;
    if (!el) return;
    const s = el.selectionStart;
    const v = el.value;
    const lineStart = v.lastIndexOf("\n", s - 1) + 1;
    onChange(v.slice(0, lineStart) + prefix + v.slice(lineStart));
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = s + prefix.length;
    });
  }

  const tabCls = (active: boolean) =>
    "px-2 py-0.5 rounded text-[11px] font-medium " +
    (active
      ? "bg-surface dark:bg-slate-700 text-content dark:text-mortar-100 shadow-sm"
      : "text-faint dark:text-slate-500 hover:text-content dark:hover:text-mortar-200");

  return (
    <div className="rounded-md border border-line dark:border-slate-600 overflow-hidden bg-surface dark:bg-slate-900/40">
      <div className="flex items-center gap-0.5 border-b border-line dark:border-slate-700 px-1 py-1">
        <Tool label="Bold" onClick={() => wrap("**")}>
          <span className="font-bold">B</span>
        </Tool>
        <Tool label="Italic" onClick={() => wrap("_")}>
          <span className="italic">I</span>
        </Tool>
        <Tool label="Heading" onClick={() => prefixLine("## ")}>
          <span className="font-semibold">H</span>
        </Tool>
        <Tool label="Bulleted list" onClick={() => prefixLine("- ")}>
          •
        </Tool>
        <Tool label="Code" onClick={() => wrap("`")}>
          <span className="font-mono text-[10px]">{"</>"}</span>
        </Tool>
        <Tool label="Link" onClick={() => wrap("[", "](https://)")}>
          <span className="underline">link</span>
        </Tool>
        <div className="ml-auto flex items-center gap-0.5">
          <button type="button" className={tabCls(tab === "write")} onClick={() => setTab("write")}>
            Write
          </button>
          <button type="button" className={tabCls(tab === "preview")} onClick={() => setTab("preview")}>
            Preview
          </button>
        </div>
      </div>
      {tab === "write" ? (
        <textarea
          ref={ref}
          value={value}
          rows={minRows}
          aria-label={ariaLabel}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          placeholder={placeholder}
          className="w-full resize-y bg-transparent px-3 py-2 text-sm text-content dark:text-mortar-100 outline-none placeholder:text-faint dark:placeholder:text-slate-600"
        />
      ) : (
        <div className="px-3 py-2 min-h-[8rem]">
          {value.trim() ? (
            <Markdown>{value}</Markdown>
          ) : (
            <span className="text-sm text-faint dark:text-slate-600">Nothing to preview yet.</span>
          )}
        </div>
      )}
    </div>
  );
}

function Tool({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      // Keep the textarea's selection: prevent the button from stealing focus.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="min-w-7 h-7 px-1.5 grid place-items-center rounded text-xs text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-700"
    >
      {children}
    </button>
  );
}
