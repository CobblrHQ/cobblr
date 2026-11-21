// The one place react-markdown is imported. Markdown.tsx loads this when a
// Markdown block is first drawn, so the renderer and its parser (about 25 KB
// gzipped) are not part of every first page load (#4945).
import ReactMarkdown, { type Components } from "react-markdown";
import { MarkdownPicture } from "./markdown-picture";
import { MarkdownOutsideLink, isOutsideLink } from "./markdown-link";

// Every picture goes through MarkdownPicture, and every link that leaves the
// app through MarkdownOutsideLink, whatever a caller passes: both are set last
// so no surface can turn them off (#4115, security). A caller's own link
// (Cobb's record chips) still draws every in-app link.
export default function MarkdownRender({ children, components }: { children: string; components?: Components }) {
  const Own = components?.a;
  const a: Components["a"] = ({ node: _node, ...props }) =>
    isOutsideLink(props.href) ? <MarkdownOutsideLink {...props} /> : Own ? <Own {...props} /> : <a {...props} />;
  return <ReactMarkdown components={{ ...components, a, img: MarkdownPicture }}>{children}</ReactMarkdown>;
}
