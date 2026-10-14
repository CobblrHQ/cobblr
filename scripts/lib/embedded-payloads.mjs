// Committed source files that are only a payload: a build of something else, base64 in a string so the
// image carries it (scripts/embed-bridge-bundle.mjs). They hold no code a lint could judge, and they
// grow with every re-embed, so a lint that walks api/src reads megabytes for nothing and its read
// budget (lib/lint-budget.mjs) creeps toward its limit. lint:hooks-served crossed it on the re-embed
// #5458 (22.6 MB against 11.2 recorded, 2026-10-09). A source walker skips these.
//
// a-big-source-file-is-a-listed-payload.test.ts keeps the list true: every .ts over 1 MB under
// api/src or modules/ must be here, so a new payload cannot slip past the walkers unnoticed.
export const EMBEDDED_PAYLOADS = ["api/src/platform/edge-bridge-bundle.ts"];

/** Is this repo path (either separator) one of the payloads? */
export const isEmbeddedPayload = (p) => EMBEDDED_PAYLOADS.includes(String(p).replace(/\\/g, "/").replace(/^\.\//, ""));

// The lints that read a payload ON PURPOSE: its checksum, its generator's
// paths. Every other lint, run under run-lints.mjs, reads a listed payload as
// an empty file (lib/lint-reads.cjs), so a new lint that walks api/src never
// reads megabytes of base64 it cannot judge: the embedded bridge bundle broke
// three lints' read budgets that way (node-resolves, mcp's two, heal-shims).
// Adding a lint here is the explicit say-so that it needs the payload itself.
export const PAYLOAD_READERS = ["lint:bridge-bundle-checksum", "lint:generated-artifact-paths"];
