// What a fresh sandbox has in it.
//
// An empty workspace is the wrong first impression. That is not a guess: the
// household demo was rebuilt this week precisely because invented names behind
// grey placeholder tiles read as a demo, while a shelf of books you recognise
// with their real covers reads as somebody's workspace. A visitor who lands on
// an empty table has been given a spreadsheet and asked to imagine.
//
// So a sandbox is seeded from a BLUEPRINT — the same mechanism a signup invite
// already carries (`signup_invites.blueprint`, applied in routes/auth.ts). The
// blueprint is data on disk, not code, so the landing page can hand out a yarn
// stash or a Lego shelf per use case with `GET /try?seed=yarn` and no deploy.
//
// Seeds live in deploy/seeds/<name>.json. A missing or malformed one is logged
// and skipped: a visitor gets an empty-but-working sandbox, never no sandbox.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyBlueprint, BlueprintManifest } from "../routes/blueprint.js";
import { signSession } from "../auth/jwt.js";
import { seedSandboxRecords } from "./try-sandbox-records.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** deploy/seeds/, resolved from this file so it works from src and from dist. */
function seedDir(): string {
  return process.env.COBBLR_TRY_SEED_DIR ?? path.resolve(HERE, "../../../deploy/seeds");
}

/** Only a bare name, and only from the seed directory: this value can come from
 *  a query string (`?seed=yarn`), so it must never be able to name a path. */
function isSafeSeedName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,40}$/.test(name);
}

export interface SeedOutcome {
  seeded: boolean;
  name: string | null;
  reason?: string;
  /** What went INTO the shape. Zero here with `seeded: true` is the empty-table
   *  failure that motivated the contents file, so the caller logs it.
   *  Named `contents`, not `records`: a module by that name exists, and the
   *  isolation lint reads a kernel file naming one as the kernel reaching into
   *  it - which it is right to do, even when this one was a coincidence.
   *  `images` settles after the visitor is already looking at the workspace. */
  contents?: { created: number; failed: number; images: Promise<number> };
}

/** Apply the named seed to a freshly provisioned sandbox.
 *
 *  Best-effort throughout — every failure path leaves a usable sandbox. The
 *  caller logs; this returns why rather than throwing, so a bad seed on the box
 *  is visible in the log without being able to take the route down. */
export async function seedSandbox(
  orgId: string,
  userId: string,
  name: string,
  slug?: string,
): Promise<SeedOutcome> {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return { seeded: false, name: null, reason: "no seed configured" };
  if (!isSafeSeedName(trimmed)) return { seeded: false, name: null, reason: `unsafe seed name: ${trimmed}` };

  let raw: string;
  try {
    raw = await readFile(path.join(seedDir(), `${trimmed}.json`), "utf8");
  } catch {
    return { seeded: false, name: trimmed, reason: "seed file not found" };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    return { seeded: false, name: trimmed, reason: `seed is not valid JSON: ${(err as Error).message}` };
  }

  const bp = BlueprintManifest.safeParse(parsedJson);
  if (!bp.success) {
    return {
      seeded: false,
      name: trimmed,
      reason: `seed failed blueprint validation: ${JSON.stringify(bp.error.issues.slice(0, 2))}`,
    };
  }

  await applyBlueprint(orgId, { id: userId, display_name: "Guest", auth_method: "session" }, bp.data);

  // The shape is up; now put something in it. A blueprint carries no records by
  // design, so without this the sandbox is correct and empty - which is the one
  // outcome this whole file exists to avoid.
  let contents: SeedOutcome["contents"];
  if (slug) {
    try {
      const outcome = await seedSandboxRecords(slug, await signSession(userId), trimmed);
      contents = { created: outcome.created, failed: outcome.failed, images: outcome.images };
    } catch (err) {
      // Never fatal: an empty-but-working sandbox beats no sandbox.
      console.error("[try-sandbox] contents failed:", (err as Error).message);
    }
  }
  return { seeded: true, name: trimmed, contents };
}
