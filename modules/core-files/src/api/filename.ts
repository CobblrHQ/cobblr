// The name a stored file is shown by, when the name it arrived with is a URL
// or a piece of one (#3833).
//
// An image fetched from a link arrives named after the link, and a link's
// last segment can be a query string: a product photo from a QR label came in
// as "?i=49325-2HHL.jpg", and the dashboard said "created ?i=49325-2HHL.jpg".
// The rule: take the path's last segment; when that is empty or only a query,
// take the first query VALUE that looks like a file name; decode it; drop
// anything a file name should not carry. A plain name passes through as is.

const HAS_EXTENSION = /\.[A-Za-z0-9]{1,5}$/;

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function readableFilename(raw: string | null | undefined, fallback = "untitled"): string {
  let name = (raw ?? "").trim();
  if (!name) return fallback;
  // A whole URL: keep its path and query, drop the host.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(name)) {
    try {
      const u = new URL(name);
      name = `${u.pathname}${u.search}`;
    } catch {
      /* not a URL after all; treat as a name */
    }
  }
  const q = name.indexOf("?");
  const pathPart = q >= 0 ? name.slice(0, q) : name;
  const query = q >= 0 ? name.slice(q + 1) : "";
  let base = decode(pathPart.split("/").filter(Boolean).pop() ?? "");
  if (!base || (!HAS_EXTENSION.test(base) && query)) {
    // The path says nothing; a query value that is a file name does.
    for (const pair of query.split("&")) {
      const v = decode(pair.includes("=") ? pair.slice(pair.indexOf("=") + 1) : pair);
      if (HAS_EXTENSION.test(v)) {
        base = v.split("/").pop() ?? v;
        break;
      }
    }
  }
  // eslint-disable-next-line no-control-regex
  base = base.replace(/[\u0000-\u001f<>:"|?*\\]/g, "").trim();
  return base || fallback;
}
