// Reading a Dockerfile's COPY lines: which paths a build takes from the build
// context. One parser, shared by lint:dockerfile-copies-ship (does the public
// export ship them) and lint:web-image-reads-what-it-copies (does the build
// read anything else).

/**
 * The build-context sources a COPY reads. The last word is the destination;
 * everything before it after the flags is a source. A `--from` stage, and an
 * absolute path an earlier stage wrote, come from inside the build and not
 * from the context.
 */
export function copySources(line: string): string[] {
  const m = /^\s*COPY\s+(.*)$/i.exec(line);
  if (!m) return [];
  const words = m[1]!.trim().split(/\s+/);
  if (words.some((w) => /^--from=/i.test(w))) return [];
  const args = words.filter((w) => !w.startsWith("--"));
  if (args.length < 2) return [];
  return args.slice(0, -1).filter((p) => !p.startsWith("/") && p !== ".");
}
