// A page's code that failed to arrive is asked for again under an address the
// browser has not seen (#7676). WebKit keeps a module that failed with a
// network error as failed for its address, across reloads: Retry reloaded the
// page, the import failed at once without asking the server, and the person
// was left on "Couldn't load this page." for good. Chromium asks again.
//
// The build rewrites every dynamic import of the app's own chunks to catch
// that failure and hand it to the boot guard (web/public/boot-guard.js,
// `__cobblrImportAgain`), which imports the same file once more with a query
// of its own. A failure that is not a chunk that did not arrive goes on as it
// was; so does the second try's, to the error boundary and the guard's retries.

/** A dynamic import of one of the build's own chunks: `import("./X-hash.js")`. */
const OWN_CHUNK_IMPORT = /(?<![\w$.])import\((["'])(\.{1,2}\/[^"'`\s]+?\.js)\1\)/g;

/** Defined once in each chunk that imports another, so each import costs a
 *  short call rather than the handler written out again: the shell's chunk
 *  imports every page, and the handler at each one was 1.8 KB of the first
 *  load (#5822). */
const HELPER = "__cobblrImportAgainIn";
const HELPER_SOURCE = `function ${HELPER}(p,s){return p.catch(function(e){var a=globalThis.__cobblrImportAgain;return a?a(e,new URL(s,import.meta.url).href):Promise.reject(e)})}\n`;

/** The chunk's code with each import of its own chunks asked again on a
 *  failure, or null when it imports none. */
export function withImportAgain(code: string): string | null {
  let changed = false;
  const out = code.replace(OWN_CHUNK_IMPORT, (whole, q: string, spec: string) => {
    changed = true;
    return `${HELPER}(${whole},${q}${spec}${q})`;
  });
  return changed ? HELPER_SOURCE + out : null;
}
