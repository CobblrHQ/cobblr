// Shared Markdown render for `richtext` field values (and any surface that shows
// Markdown). react-markdown@9 renders CommonMark and, by default, does NOT emit
// raw HTML — so a stored Markdown string is safe to render without a sanitizer
// (no XSS surface). Styling matches the app convention (Tailwind Typography
// `prose`), same as ChatWidget / BundleDetailModal.
import { Component, lazy, Suspense, useEffect, useState, type ComponentType, type ReactNode } from "react";
import type { Components } from "react-markdown";

type RenderProps = { children: string; components?: Components };
type Load = () => Promise<{ default: ComponentType<RenderProps> }>;

/** Catches the renderer's failed load so it never reaches a boundary above:
 *  in the side panel that boundary was the Cobb host's, and the panel lost
 *  Cobb for a renderer that only makes words bold (#7848). */
class PlainOnFail extends Component<{ plain: ReactNode; onFail: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    console.warn("[markdown] renderer not loaded yet:", error.message);
    this.props.onFail();
  }
  render() {
    return this.state.failed ? this.props.plain : this.props.children;
  }
}

/** Markdown rendered as elements, from a renderer that loads on first use.
 *  Until it arrives the words show as plain text in the same place; if it
 *  cannot arrive (offline), they stay plain text and it is asked for again
 *  when the device is back online. A rejected lazy() stays rejected, so the
 *  retry is a fresh one, shared by every place showing Markdown. */
export function markdownTextFrom(load: Load) {
  let Render = lazy(load);
  return function MarkdownText({ children, components }: RenderProps) {
    const [failedOn, setFailedOn] = useState<typeof Render | null>(null);
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
      if (!failedOn) return;
      const again = () => {
        if (Render === failedOn) Render = lazy(load);
        setFailedOn(null);
        setAttempt((n) => n + 1);
      };
      window.addEventListener("online", again);
      return () => window.removeEventListener("online", again);
    }, [failedOn]);
    const plain = <p className="whitespace-pre-wrap">{children}</p>;
    if (failedOn) return plain;
    const Now = Render;
    return (
      <PlainOnFail key={attempt} plain={plain} onFail={() => setFailedOn(Now)}>
        <Suspense fallback={plain}>
          <Now components={components}>{children}</Now>
        </Suspense>
      </PlainOnFail>
    );
  };
}

/** Markdown rendered as elements, with no wrapper of its own. Every surface
 *  that renders Markdown comes through here (capability markdown:render). */
export const MarkdownText = markdownTextFrom(() => import("./markdown-render"));

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
