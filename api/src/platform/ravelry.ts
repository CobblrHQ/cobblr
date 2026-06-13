// Minimal read-only Ravelry API client (https://api.ravelry.com). Auth is HTTP
// Basic with a user's "personal" access key + secret (read-only, their own
// account) — see docs/design-decisions/ravelry-importer.md. Never logs creds.

const BASE = "https://api.ravelry.com";

export interface RavelryCreds {
  access_key: string;
  personal_key: string;
}

export class RavelryError extends Error {
  constructor(
    public status: number,
    body: string,
  ) {
    super(`Ravelry ${status}: ${body}`);
    this.name = "RavelryError";
  }
}

function authHeader(creds: RavelryCreds): string {
  return "Basic " + Buffer.from(`${creds.access_key}:${creds.personal_key}`).toString("base64");
}

async function get<T>(creds: RavelryCreds, path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: authHeader(creds), accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new RavelryError(res.status, body.slice(0, 300));
  }
  return (await res.json()) as T;
}

/** The authed user — verifies the creds AND resolves the username. */
export async function currentUser(creds: RavelryCreds): Promise<{ username: string } | null> {
  const d = await get<{ user?: { username?: string } }>(creds, "/current_user.json");
  return d.user?.username ? { username: d.user.username } : null;
}

// The Ravelry payloads are large + loosely typed; the mapper reads only the
// fields it needs, defensively. Keep these as open records.
export type RavelryStashEntry = Record<string, unknown> & { id: number };
export type RavelryProject = Record<string, unknown> & { id: number };

interface Paginator {
  page: number;
  page_count: number;
}

async function* paginate<T>(
  creds: RavelryCreds,
  pathFor: (page: number) => string,
  pick: (d: Record<string, unknown>) => T[],
): AsyncGenerator<T> {
  let page = 1;
  for (;;) {
    const d = (await get<Record<string, unknown>>(creds, pathFor(page))) ?? {};
    const items = pick(d) ?? [];
    for (const it of items) yield it;
    const p = d.paginator as Paginator | undefined;
    if (!p || page >= (p.page_count || page) || items.length === 0) break;
    page++;
  }
}

/** Every stash entry for a user (paginated). List view is partial — fetch
 *  stashDetail for the full field set when mapping. */
export function stashAll(creds: RavelryCreds, username: string): AsyncGenerator<RavelryStashEntry> {
  const u = encodeURIComponent(username);
  return paginate(creds, (page) => `/people/${u}/stash/list.json?page=${page}&page_size=100`, (d) => (d.stash as RavelryStashEntry[]) ?? []);
}

export function projectsAll(creds: RavelryCreds, username: string): AsyncGenerator<RavelryProject> {
  const u = encodeURIComponent(username);
  return paginate(creds, (page) => `/projects/${u}/list.json?page=${page}&page_size=100`, (d) => (d.projects as RavelryProject[]) ?? []);
}

export async function stashDetail(creds: RavelryCreds, username: string, id: number | string): Promise<RavelryStashEntry | null> {
  const d = await get<{ stash?: RavelryStashEntry }>(creds, `/people/${encodeURIComponent(username)}/stash/${id}.json`);
  return d.stash ?? null;
}

export async function projectDetail(creds: RavelryCreds, username: string, id: number | string): Promise<RavelryProject | null> {
  const d = await get<{ project?: RavelryProject }>(creds, `/projects/${encodeURIComponent(username)}/${id}.json`);
  return d.project ?? null;
}
