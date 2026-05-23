// Default-exported Router. Mounted at
//   /api/v1/orgs/:slug/modules/core-openapi/
// with requireAuth + withTenant already applied by the platform.

import { Router } from "express";
import { platform, type EntityFieldDecl } from "@cobblr/platform-contract";

const router = Router({ mergeParams: true });

router.get("/openapi.json", (_req, res, next) => {
  void (async () => {
    const spec = await buildSpec();
    res.type("application/json").json(spec);
  })().catch(next);
});

interface OpenApiSchema {
  type?: string;
  format?: string;
  description?: string;
  enum?: readonly string[];
  items?: OpenApiSchema;
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  nullable?: boolean;
  $ref?: string;
}

async function buildSpec(): Promise<unknown> {
  const kinds = await platform().entities.listKinds();

  const schemas: Record<string, OpenApiSchema> = {};
  for (const k of kinds) {
    schemas[entityKindSchemaId(k.id)] = entityKindToSchema(k.id, k.fields);
  }

  // Common envelope shapes the platform routes share.
  schemas.ListResult = {
    type: "object",
    properties: {
      items: { type: "array", items: { type: "object" } },
      total: { type: "integer" },
    },
    required: ["items"],
  };
  schemas.Error = {
    type: "object",
    properties: {
      error: {
        type: "object",
        properties: {
          code: { type: "string" },
          message: { type: "string" },
          details: {} as OpenApiSchema,
        },
        required: ["code", "message"],
      },
    },
    required: ["error"],
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "Cobblr API",
      version: "0.1.0",
      description:
        "Auto-generated from the live module registry. Schemas mirror each enabled module's entity-kind declarations; paths cover the well-known platform routes and the per-module CRUD pattern.",
    },
    servers: [{ url: "/api/v1" }],
    paths: platformPaths(kinds.map((k) => k.id)),
    components: {
      schemas,
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "Session JWT or long-lived API token (cbt_…).",
        },
      },
    },
    security: [{ bearerAuth: [] }],
  };
}

function entityKindSchemaId(kindId: string): string {
  // 'inventory:part' → 'Inventory.Part' (OpenAPI components/schemas
  // keys must match ^[a-zA-Z0-9.\-_]+$).
  const [mod, type] = kindId.split(":");
  return `${cap(mod ?? "")}.${cap(type ?? "")}`.replace(/[^a-zA-Z0-9.\-_]/g, "_");
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/-/g, "_");
}

function entityKindToSchema(
  kindId: string,
  fields: EntityFieldDecl[],
): OpenApiSchema {
  const properties: Record<string, OpenApiSchema> = {
    id: { type: "string", format: "uuid", description: "Server-assigned id" },
  };
  const required: string[] = [];
  for (const f of fields) {
    properties[f.name] = fieldToSchema(f);
    if (f.required) required.push(f.name);
  }
  return {
    type: "object",
    description: `Entity kind ${kindId}`,
    properties,
    required: required.length > 0 ? required : undefined,
  };
}

function fieldToSchema(f: EntityFieldDecl): OpenApiSchema {
  switch (f.type) {
    case "text":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "date":
      return { type: "string", format: "date-time" };
    case "url":
      return { type: "string", format: "uri" };
    case "image-path":
      return { type: "string", description: "Relative path or URL to an image asset" };
    default:
      return { type: "string" };
  }
}

function platformPaths(kindIds: string[]): Record<string, unknown> {
  // A representative subset of the platform's well-known routes.
  // Per-module CRUD is documented as a single templated pattern
  // rather than enumerated per kind — keeps the doc compact and
  // works for kinds added at runtime via bundles.
  const paths: Record<string, unknown> = {
    "/healthz": {
      get: {
        summary: "Process liveness check (no auth)",
        responses: {
          "200": {
            description: "Service up",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
    "/auth/signup": {
      post: {
        summary: "Create a new user + provision their first workspace",
        responses: {
          "201": { description: "Created" },
          "400": { description: "Invalid body" },
        },
      },
    },
    "/auth/login": {
      post: {
        summary: "Exchange email + password for a session JWT",
        responses: {
          "200": { description: "OK" },
          "401": { description: "Bad credentials" },
        },
      },
    },
    "/modules": {
      get: {
        summary: "List every installed module (registry-wide)",
        responses: { "200": { description: "OK" } },
      },
    },
    "/orgs/{slug}/modules": {
      get: {
        summary: "Per-org module status (enabled? installed-version?)",
        parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "OK" } },
      },
    },
    "/orgs/{slug}/modules/core-search/search": {
      get: {
        summary: "Free-text search across every kind with a list resolver",
        parameters: [
          { name: "slug", in: "path", required: true, schema: { type: "string" } },
          { name: "q", in: "query", required: true, schema: { type: "string" } },
          { name: "kinds", in: "query", required: false, schema: { type: "string" } },
        ],
        responses: { "200": { description: "OK" } },
      },
    },
    "/orgs/{slug}/modules/core-views/views": {
      get: {
        summary: "List saved views (optionally filtered by ?kind=)",
        parameters: [
          { name: "slug", in: "path", required: true, schema: { type: "string" } },
          { name: "kind", in: "query", required: false, schema: { type: "string" } },
        ],
        responses: { "200": { description: "OK" } },
      },
      post: {
        summary: "Save a new view",
        responses: { "201": { description: "Created" } },
      },
    },
    "/orgs/{slug}/modules/core-files/files": {
      post: {
        summary: "Upload a file (multipart, field 'file')",
        responses: {
          "201": { description: "Uploaded" },
          "400": { description: "Missing field" },
        },
      },
      get: {
        summary: "List uploaded files (paginated, ?kind= filterable)",
        parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "OK" } },
      },
    },
    "/orgs/{slug}/modules/core-healthcheck/snapshot": {
      get: {
        summary: "Aggregated health-probe snapshot",
        parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "All probes ok or degraded" },
          "503": { description: "At least one probe in error" },
        },
      },
    },
  };

  // Per-module CRUD pattern — documented as a single templated path
  // with the available kinds enumerated in the description, so the
  // doc reader knows what {kind} values are valid without enumerating
  // every URL.
  paths["/orgs/{slug}/modules/{module}/{collection}"] = {
    get: {
      summary: "Module CRUD pattern (list)",
      description:
        "Each module mounts its own router under /modules/{module}/. Known kinds today: " +
        kindIds.map((k) => `\`${k}\``).join(", "),
      parameters: [
        { name: "slug", in: "path", required: true, schema: { type: "string" } },
        { name: "module", in: "path", required: true, schema: { type: "string" } },
        { name: "collection", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: { "200": { description: "OK" } },
    },
    post: {
      summary: "Module CRUD pattern (create)",
      responses: { "201": { description: "Created" } },
    },
  };

  return paths;
}

export default router;
