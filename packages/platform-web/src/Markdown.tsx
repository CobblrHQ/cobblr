// Shared Markdown render for `richtext` field values (and any surface that shows
// Markdown). react-markdown@9 renders CommonMark and, by default, does NOT emit
// raw HTML — so a stored Markdown string is safe to render without a sanitizer
// (no XSS surface). Styling matches the app convention (Tailwind Typography
// `prose`), same as ChatWidget / BundleDetailModal.
import { lazy, Suspense } from "react";
import type { Components } from "react-markdown";

const Render = lazy(() => import("./markdown-render"));

/** Markdown rendered as elements, with no wrapper of its own. The renderer
 *  loads on first use; until it arrives the words show as plain text in the
 *  same place, so nothing is blank and nothing jumps far. Every surface that
 *  renders Markdown comes through here (capability markdown:render). */
export function MarkdownText({ children, components }: { children: string; components?: Components }) {
  return (
    <Suspense fallback={<p className="whitespace-pre-wrap">{children}</p>}>
      <Render components={components}>{children}</Render>
    </Suspense>
  );
}

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div
      className={
        "prose prose-sm dark:prose-invert max-w-none text-content dark:text-mortar-100 " +
        "prose-p:my-1.5 prose-headings:my-2 prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5 " +
        "prose-pre:my-2 prose-a:text-accent break-words " +
        (className ?? "")
      }
    >
      <MarkdownText>{children}</MarkdownText>
    </div>
  );
}

/** A one-line plain-text digest of a Markdown string — for inline / table cells
 *  where a full rendered block would be ugly. Strips the common syntax. */
export function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ") // fenced code blocks
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links → their text
    .replace(/^#{1,6}\s+/gm, "") // headings
    .replace(/^\s*[-+*]\s+/gm, "") // list bullets
    .replace(/[*_~>#]/g, "") // emphasis / blockquote / stray marks
    .replace(/\s+/g, " ")
    .trim();
}
