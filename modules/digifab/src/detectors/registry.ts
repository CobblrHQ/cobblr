// Detector registry — resolves a package by key and runs it. Built-ins (edge,
// llm) + external declarative packages (obico-ml, printguard, local-http) are
// self-contained folders under ./<key>/index.ts, collected on disk by
// scripts/gen-detectors.mjs into ./builtins.generated.ts. Present folder →
// wired; delete a folder → held back, no build break (subset shipping — e.g.
// omit the AGPL/GPL manifests from a distributed build). Mirrors the edge-bridge
// driver refactor.

import { BUILTINS } from "./builtins.generated.js";
import { runDetectorManifest } from "./engine.js";
import type { DetectorContext, DetectorPackage } from "./types.js";

const BY_KEY = new Map<string, DetectorPackage>(BUILTINS.map((p) => [p.key, p]));

/** Resolve a detector package by key, or null if not wired. */
export function resolveDetector(key: string): DetectorPackage | null {
  return BY_KEY.get(key) ?? null;
}

/** The external detectors an operator can point at a base URL (for the UI picker). */
export function detectorCatalog(): Array<{ key: string; name: string; summary?: string; shape: string }> {
  return BUILTINS.filter((p) => p.external && p.manifest).map((p) => ({
    key: p.key,
    name: p.name,
    summary: p.summary,
    shape: p.manifest!.shape,
  }));
}

/** Run a package against a context: its code hook, else its declarative manifest.
 *  Returns a probability in [0,1], or null for no reading. */
export async function runDetector(pkg: DetectorPackage, ctx: DetectorContext): Promise<{ probability: number } | null> {
  if (pkg.score) return pkg.score(ctx);
  if (pkg.manifest) return runDetectorManifest(pkg.manifest, ctx);
  return null;
}
