// The one place react-markdown is imported. Markdown.tsx loads this when a
// Markdown block is first drawn, so the renderer and its parser (about 25 KB
// gzipped) are not part of every first page load (#4945).
import ReactMarkdown, { type Components } from "react-markdown";

export default function MarkdownRender({ children, components }: { children: string; components?: Components }) {
  return <ReactMarkdown components={components}>{children}</ReactMarkdown>;
}
