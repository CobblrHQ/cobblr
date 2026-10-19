// THE workspace tool registry — every read/write an AI surface can perform on
// a workspace, defined ONCE. Consumers:
//   - the in-app Ask Cobb chat: read tools auto-run inside the agent loop
//     (through the caller's own permissions); WRITE tools become PROPOSALS the
//     user confirms — the chat never mutates inline;
//   - the MCP server: registers each tool 1:1 for an external Claude (writes
//     execute directly there — the external client owns its own confirm UX).
// Tool `mode` is what encodes that difference; descriptions are written for
// the MODEL (guidance on when to reach for each tool lives here, not in
// per-consumer prompts).
// Secret reveal and copy stay outside this registry: only a person's explicit
// audited action may read them, and their values must never enter model context.
//
// Adding a capability = one new file in ./tools/, named for the tool
// (tools/list-records.ts is list_records), whose default export is the tool;
// both surfaces get it. Nothing lists the files: they are found here, so two
// pull requests adding unrelated tools share no file (#7388). Shared helpers
// live in ./tool-kit.ts. Never add a tool to a consumer directly.

import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { honestTransport } from "./api.js";
import type { WorkspaceTool } from "./tool-kit.js";

export * from "./tool-kit.js";
export * from "./escort-destinations.js";

declare global {
  interface ImportMeta {
    /** Vite's: turned into static imports when Vitest transforms this file. */
    glob(patterns: string[], options: { eager: true }): Record<string, unknown>;
  }
}

/** The file a tool lives in: its name with dashes (list_records → list-records). */
export const toolFileName = (name: string): string => name.replaceAll("_", "-");

/** Every tool file's module, loaded synchronously, so every importer (an ESM
 *  service, a CommonJS script under tsx, a Vitest run) gets the whole registry
 *  at import time. Not a top-level await: a script tsx runs as CommonJS cannot
 *  load a module that has one, and the bench and the lints are such scripts. */
function toolModules(): Array<[string, unknown]> {
  if (process.env.VITEST) {
    return Object.entries(import.meta.glob(["./tools/*.ts", "./tools/*.js", "!./tools/*.d.ts", "!./tools/*.test.*"], { eager: true })).map(([p, m]) => [p.slice(p.lastIndexOf("/") + 1), m]);
  }
  // ESM has import.meta.url; tsx's CommonJS output empties import.meta and has require and __dirname.
  const esm = typeof import.meta.url === "string";
  const req = esm ? createRequire(import.meta.url) : require;
  const dir = join(esm ? dirname(fileURLToPath(import.meta.url)) : __dirname, "tools");
  return readdirSync(dir)
    // Every module file, so a misnamed one is refused below rather than skipped.
    .filter((f) => /\.(ts|js)$/.test(f) && !f.endsWith(".d.ts") && !/\.test\.(ts|js)$/.test(f))
    .map((f) => [f, req(join(dir, f))]);
}

function discoverTools(): WorkspaceTool[] {
  const modules = toolModules().sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (!modules.length) throw new Error("workspace-tools: no tool files in tools/");
  return modules.map(([f, mod]) => {
    const tool = (mod as { default?: WorkspaceTool }).default;
    if (!tool?.name || typeof tool.execute !== "function") throw new Error(`workspace-tools: tools/${f} has no tool as its default export`);
    if (`${toolFileName(tool.name)}${f.slice(f.lastIndexOf("."))}` !== f) throw new Error(`workspace-tools: tools/${f} holds ${tool.name}; name the file ${toolFileName(tool.name)}`);
    return tool;
  });
}

/** Every tool, in file-name order: the same order on every surface and every turn. */
export const WORKSPACE_TOOLS: WorkspaceTool[] = discoverTools();

// Every tool runs over the honest transport, whoever calls it (the chat, the
// stdio MCP server, the hosted MCP endpoint): a request with no HTTP answer is
// a failure in every tool's own status check, never a success (#6968).
for (const t of WORKSPACE_TOOLS) {
  const run = t.execute;
  t.execute = (api, args) => run(honestTransport(api), args);
}


export function getTool(name: string): WorkspaceTool | undefined {
  return WORKSPACE_TOOLS.find((t) => t.name === name);
}

export const READ_TOOLS = WORKSPACE_TOOLS.filter((t) => t.mode === "read");
export const WRITE_TOOLS = WORKSPACE_TOOLS.filter((t) => t.mode === "write");

// ─────────────────────── the MCP naming policy, once ──────────────────────
//
// Three surfaces read this registry: the in-app chat (bare names), and TWO MCP
// faces — the stdio server (packages/mcp-server) and the HTTP endpoint
// (api/src/platform/hosted-mcp.ts). Both MCP faces prefix every tool the same
// way, and both used to hardcode that prefix themselves. Two copies of a naming
// policy is how one face ends up exposing a different set from the other, which
// is precisely what happened: the HTTP face carried a hand-kept SIX while this
// registry held twenty-one, and nothing noticed because a model with fewer
// tools does not error, it just answers (2026-08-15).
//
// The per-transport parts stay per-transport: each face describes its own
// `workspace` argument in its own terms (an env var for stdio, a query param
// for HTTP), because those genuinely differ.

/** The prefix both MCP faces put on every workspace tool. */
export const MCP_TOOL_PREFIX = "cobblr_";

/** A registry tool's name as MCP clients see it. */
export function mcpToolName(bareName: string): string {
  return `${MCP_TOOL_PREFIX}${bareName}`;
}

/** MCP name → the registry tool it addresses (null when it isn't one of ours). */
export function toolFromMcpName(mcpName: string): WorkspaceTool | undefined {
  return mcpName.startsWith(MCP_TOOL_PREFIX)
    ? getTool(mcpName.slice(MCP_TOOL_PREFIX.length))
    : undefined;
}

/** The most characters a result of `name` may be trimmed to, given the
 *  caller's usual budget: unlimited for a tool that must arrive whole. One
 *  answer for the chat loop and the bench, so neither trims what the other keeps. */
export function resultBudgetFor(name: string, usual: number): number {
  return WORKSPACE_TOOLS.find((t) => t.name === name)?.wholeResult ? Number.POSITIVE_INFINITY : usual;
}
