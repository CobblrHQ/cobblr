// Seed a demo tenant against a running cobblr-api. Drives the public
// HTTP API so it exercises the same code path users do, including
// signup → default-binding seeding → module CRUD.
//
// Usage:
//   COBBLR_API=http://localhost:4000 tsx api/src/scripts/seed-demo.ts
//
// Idempotent on re-run only via random email suffix — every run
// creates a new org. Print the slug + login on stdout so the user
// can `claude` into it.

const API = process.env.COBBLR_API ?? "http://localhost:4000";

interface Session {
  token: string;
  slug: string;
}

async function http<T>(
  session: Session | null,
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE" = "GET",
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (session) headers.Authorization = `Bearer ${session.token}`;
  let payload: string | undefined;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${API}${path}`, { method, headers, body: payload });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

async function main() {
  const suffix = Math.random().toString(36).slice(2, 6);
  const email = `demo-${suffix}@cobblr.dev`;
  const password = "demodemo1234";

  console.log(`▶ creating demo org (email: ${email})`);
  const signup = await http<{ token: string; orgs: { slug: string }[] }>(
    null,
    "/api/v1/auth/signup",
    "POST",
    {
      email,
      password,
      display_name: `Demo ${suffix}`,
      org_name: `Demo Workshop ${suffix}`,
    },
  );
  const s: Session = { token: signup.token, slug: signup.orgs[0]!.slug };
  console.log(`  → slug: ${s.slug}`);

  // ── Inventory: a small parts catalog ───────────────────────────
  console.log("▶ seeding inventory parts");
  const parts = [
    { name: "M3 × 12 socket head cap screw", qty: 200, min_qty: 50 },
    { name: "M5 × 16 button head cap screw", qty: 84, min_qty: 30 },
    { name: "608ZZ bearing (8×22×7)", qty: 18, min_qty: 8 },
    { name: "GT2 belt — 6mm × 1m loop", qty: 4, min_qty: 2 },
    { name: "Voron Stealthburner toolhead PCB", qty: 1, min_qty: 1 },
    { name: "PETG — black — 1kg spool", qty: 6, min_qty: 4 },
    { name: "Heat-set insert M3 × 5", qty: 312, min_qty: 100 },
    { name: "Linear rail MGN12 × 350mm", qty: 2, min_qty: 2 },
  ];
  const createdParts: Array<{ id: string; name: string }> = [];
  for (const p of parts) {
    const row = await http<{ id: string; name: string }>(
      s,
      `/api/v1/orgs/${s.slug}/modules/inventory/parts`,
      "POST",
      p,
    );
    createdParts.push(row);
    console.log(`  + ${row.name}`);
  }

  // ── Projects + tasks, some with deps on parts ──────────────────
  console.log("▶ seeding projects + tasks");
  const proj1 = await http<{ id: string }>(
    s,
    `/api/v1/orgs/${s.slug}/modules/projects/projects`,
    "POST",
    { name: "Voron 2.4 build", description: "Initial build + first calibration prints" },
  );
  const proj2 = await http<{ id: string }>(
    s,
    `/api/v1/orgs/${s.slug}/modules/projects/projects`,
    "POST",
    { name: "Workshop reorg — Q2", description: "Pegboard, bins, label everything" },
  );

  const task1 = await http<{ id: string }>(
    s,
    `/api/v1/orgs/${s.slug}/modules/projects/tasks`,
    "POST",
    { project_id: proj1.id, title: "Install heat-set inserts into gantry frames" },
  );
  await http(
    s,
    `/api/v1/orgs/${s.slug}/modules/projects/tasks/${task1.id}/dependencies`,
    "POST",
    {
      target_module: "inventory",
      target_entity_type: "part",
      target_entity_id: createdParts.find((p) => p.name.startsWith("Heat-set"))!.id,
      note: "need ~100 inserts",
    },
  );

  const task2 = await http<{ id: string }>(
    s,
    `/api/v1/orgs/${s.slug}/modules/projects/tasks`,
    "POST",
    { project_id: proj1.id, title: "Belt-tension the X axis" },
  );
  await http(
    s,
    `/api/v1/orgs/${s.slug}/modules/projects/tasks/${task2.id}/dependencies`,
    "POST",
    {
      target_module: "inventory",
      target_entity_type: "part",
      target_entity_id: createdParts.find((p) => p.name.startsWith("GT2"))!.id,
    },
  );

  await http(
    s,
    `/api/v1/orgs/${s.slug}/modules/projects/tasks`,
    "POST",
    { project_id: proj2.id, title: "Sort fasteners into labeled bins" },
  );
  await http(
    s,
    `/api/v1/orgs/${s.slug}/modules/projects/tasks`,
    "POST",
    { project_id: proj2.id, title: "Inventory: stock-check all materials" },
  );

  // ── Install the Lego community bundle so the demo shows cross-
  //    cutting concepts (custom field defs + a templated wire). ──
  console.log("▶ installing Lego community bundle");
  await http(
    s,
    `/api/v1/orgs/${s.slug}/bundles/install`,
    "POST",
    {
      manifest: {
        id: "cobblr.community.lego",
        version: "0.1.0",
        name: "Lego Collector",
        description: "Custom inventory fields + label wires for Lego collections.",
        requires: [{ module: "inventory" }, { module: "labels" }],
        wires: [
          {
            source_kind: "inventory:part",
            action_id: "labels:print",
            trigger_type: "user-invoked",
            template: 'LEGO {{theme | default: "misc"}} #{{set_id | default: "---"}} • {{name}}',
          },
        ],
        field_defs: [
          { entity_kind: "inventory:part", name: "set_id", display_label: "Set ID", type: "text", position: 1 },
          { entity_kind: "inventory:part", name: "year", display_label: "Year", type: "number", position: 2 },
          { entity_kind: "inventory:part", name: "theme", display_label: "Theme", type: "text", position: 3 },
        ],
      },
    },
  );

  // Add a Lego part too so the field defs have something to show on.
  await http(
    s,
    `/api/v1/orgs/${s.slug}/modules/inventory/parts`,
    "POST",
    { name: "Razor Crest", qty: 1, min_qty: 1 },
  );

  console.log("");
  console.log("✓ demo org ready");
  console.log(`  email: ${email}`);
  console.log(`  password: ${password}`);
  console.log(`  slug: ${s.slug}`);
  console.log(`  url: ${API}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
