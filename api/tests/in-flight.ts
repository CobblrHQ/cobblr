// "This write has not landed yet", for a test against the running api (#3119).
//
// A fixture is settled by construction, so a defect that lives in WHEN two
// writes land is invisible to every test built from one. This is the seam the
// suite reaches for instead: hold the outbound I/O a detached writer is
// waiting on (a search, a download, a provider), land the competing write,
// release, and assert the outcome. The hold is the api's own
// (/test-support/hold-outbound, backed by @cobblr/platform-net's one fetch
// loop), so nothing in a module needs a seam of its own.
//
//   const held = await holdOutbound({ includes: "/race/", png: bytes });
//   trigger the detached writer;
//   await held.reached(1);          // the positive control: it IS in flight
//   land the person's write;
//   await held.release();
//   await held.returned(1);         // the writer was let through
//   ... then assert what the row says, with a twin that had no competing
//   write as the proof that the writer's own write lands when nothing stops it.
//
// `reached` THROWS when nothing arrives in time: a race test whose held
// writer never went out has proven nothing, and must say so rather than pass.
import { BASE } from "./helpers.js";

export interface HoldStatus {
  id: string;
  includes: string;
  reached: number;
  returned: number;
  released: boolean;
  canned: boolean;
}

export interface Held {
  id: string;
  status(): Promise<HoldStatus>;
  /** Resolves once at least `n` fetches have reached the hold; throws after `timeoutMs` (default 10 s). */
  reached(n: number, timeoutMs?: number): Promise<HoldStatus>;
  /** Resolves once at least `n` fetches have been let through; throws after `timeoutMs`. */
  returned(n: number, timeoutMs?: number): Promise<HoldStatus>;
  release(): Promise<void>;
  /** Release and drop the record. Call in afterAll. */
  forget(): Promise<void>;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

/** Is the api one that opens test doors at all? (The router is mounted only
 *  under COBBLR_TEST_ORG_POOL.) A test skips, never passes, without it. */
export async function holdsAvailable(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/api/v1/test-support/hold-outbound/none`);
    return r.status === 404 && ((await r.json()) as { error?: { code?: string } }).error?.code === "not_found";
  } catch {
    return false;
  }
}

export async function holdOutbound(spec: {
  includes: string;
  /** Answer with this PNG (200 image/png) once released. */
  png?: Uint8Array | Buffer;
  /** Or any canned answer. */
  respond?: { status?: number; content_type?: string; body?: Uint8Array | Buffer };
  auto_release_ms?: number;
}): Promise<Held> {
  const canned = spec.png
    ? { status: 200, content_type: "image/png", body_base64: Buffer.from(spec.png).toString("base64") }
    : spec.respond
      ? {
          ...(spec.respond.status !== undefined ? { status: spec.respond.status } : {}),
          ...(spec.respond.content_type !== undefined ? { content_type: spec.respond.content_type } : {}),
          ...(spec.respond.body !== undefined ? { body_base64: Buffer.from(spec.respond.body).toString("base64") } : {}),
        }
      : {};
  const r = await fetch(
    `${BASE}/api/v1/test-support/hold-outbound`,
    json("POST", { includes: spec.includes, ...canned, ...(spec.auto_release_ms !== undefined ? { auto_release_ms: spec.auto_release_ms } : {}) }),
  );
  if (r.status !== 201) throw new Error(`hold-outbound refused (${r.status}): ${await r.text()}`);
  const { id } = (await r.json()) as HoldStatus;
  const url = `${BASE}/api/v1/test-support/hold-outbound/${id}`;
  const status = async (): Promise<HoldStatus> => {
    const s = await fetch(url);
    if (s.status !== 200) throw new Error(`hold ${id} unreadable (${s.status})`);
    return (await s.json()) as HoldStatus;
  };
  const until = async (what: "reached" | "returned", n: number, timeoutMs: number): Promise<HoldStatus> => {
    const deadline = Date.now() + timeoutMs;
    let last = await status();
    while (last[what] < n) {
      if (Date.now() >= deadline) {
        throw new Error(
          what === "reached"
            ? `nothing reached the hold on "${spec.includes}" within ${timeoutMs}ms (reached=${last.reached}): the writer never went out, so there is no race to judge`
            : `the hold on "${spec.includes}" let ${last.returned} through, not ${n}, within ${timeoutMs}ms (released=${last.released})`,
        );
      }
      await new Promise((res) => setTimeout(res, 100));
      last = await status();
    }
    return last;
  };
  return {
    id,
    status,
    reached: (n, timeoutMs = 10_000) => until("reached", n, timeoutMs),
    returned: (n, timeoutMs = 10_000) => until("returned", n, timeoutMs),
    release: async () => {
      await fetch(url, json("DELETE"));
    },
    forget: async () => {
      await fetch(`${url}?forget=1`, json("DELETE"));
    },
  };
}
