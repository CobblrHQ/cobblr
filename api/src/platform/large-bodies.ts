// The one list of routes that take more than the default JSON body.
//
// The global parser in server.ts reads every body before any router runs, so a
// larger limit or a schema's .max() further along is never reached: the route
// only sees what got past here. Each row states which file's schema it serves,
// and lint:dead-route-parsers fails when a schema promises more than its row
// (or the default) can read.

export interface LargeBody {
  name: string;
  methods: readonly string[];
  path: RegExp;
  limit: `${number}mb`;
  /** One real path of the route. A test checks the api answers it and `path` matches it. */
  example: `${string} /api/v1/${string}`;
  /** The files whose schemas promise bodies this big. */
  promisedIn: readonly string[];
  /** Keep the exact bytes for a signature over them. */
  keepRaw?: boolean;
}

export const DEFAULT_BODY_LIMIT = "1mb";

export const LARGE_BODIES: readonly LargeBody[] = [
  {
    name: "a bridge's reply with file bytes",
    methods: ["POST"],
    path: /\/modules\/digifab\/edge\/respond$/,
    limit: "20mb",
    example: "POST /api/v1/orgs/:slug/modules/digifab/edge/respond",
    promisedIn: [],
  },
  {
    name: "a Homebox export or a spreadsheet",
    methods: ["POST"],
    path: /\/modules\/core-import\/(homebox|sheets)/,
    limit: "24mb",
    example: "POST /api/v1/orgs/:slug/modules/core-import/sheets/import",
    promisedIn: [],
  },
  {
    name: "a scan inbox export with its photos",
    methods: ["POST"],
    path: /\/modules\/core-scan\/import(\/preview)?$/,
    limit: "32mb",
    example: "POST /api/v1/orgs/:slug/modules/core-scan/import/preview",
    promisedIn: [],
  },
  {
    name: "what another instance sends over a share",
    methods: ["POST"],
    path: /^\/api\/v1\/share-links\/[^/]+\/[a-z-]+$/,
    limit: "64mb",
    example: "POST /api/v1/share-links/:id/ops",
    promisedIn: [],
    keepRaw: true,
  },
  {
    name: "a sent file of records",
    methods: ["POST"],
    path: /^\/api\/v1\/orgs\/[^/]+\/records\/send\/file\/(import|confirm|restore)$/,
    limit: "64mb",
    example: "POST /api/v1/orgs/:slug/records/send/file/import",
    promisedIn: [],
  },
  {
    name: "a CSV of places",
    methods: ["POST"],
    path: /\/modules\/core-locations\/locations\/import$/,
    limit: "12mb",
    example: "POST /api/v1/orgs/:slug/modules/core-locations/locations/import",
    promisedIn: ["modules/core-locations/src/api/import.ts"],
  },
  {
    name: "a CSV for a catalog",
    methods: ["POST"],
    path: /\/modules\/core-catalogs\/catalogs\/[^/]+\/import-csv$/,
    limit: "48mb",
    example: "POST /api/v1/orgs/:slug/modules/core-catalogs/catalogs/:id/import-csv",
    promisedIn: ["modules/core-catalogs/src/api/catalogs.ts"],
  },
  {
    name: "a BrickLink wanted list or order",
    methods: ["POST"],
    path: /\/modules\/bricklink-connector\/(parse-order|parse-wanted-list|diff-wanted-list)$/,
    limit: "12mb",
    example: "POST /api/v1/orgs/:slug/modules/bricklink-connector/parse-order",
    promisedIn: ["modules/bricklink-connector/src/api/index.ts"],
  },
  {
    name: "a file preview renderer",
    methods: ["POST"],
    path: /\/modules\/core-file-preview\/renderers\/?$/,
    limit: "5mb",
    example: "POST /api/v1/orgs/:slug/modules/core-file-preview/renderers/",
    promisedIn: ["modules/core-file-preview/src/api/renderers.ts"],
  },
  {
    name: "an app's theme with its logo and font",
    methods: ["POST", "PATCH"],
    path: /\/modules\/core-apps\/apps(\/[^/]+)?\/?$/,
    limit: "4mb",
    example: "PATCH /api/v1/orgs/:slug/modules/core-apps/apps/:slug",
    promisedIn: ["modules/core-apps/src/api/apps.ts"],
  },
  {
    name: "a portal's theme with its logo and font",
    methods: ["PUT"],
    path: /^\/api\/v1\/orgs\/[^/]+\/portal-config$/,
    limit: "4mb",
    example: "PUT /api/v1/orgs/:slug/portal-config",
    promisedIn: ["api/src/routes/portal.ts"],
  },
  {
    name: "an emailed receipt with its attachments",
    methods: ["POST"],
    path: /^\/api\/v1\/(inbound-email|receipt-ingest\/email)$/,
    limit: "64mb",
    example: "POST /api/v1/inbound-email",
    promisedIn: ["api/src/routes/inbound-email.ts", "api/src/routes/receipt-ingest.ts"],
  },
  {
    name: "an instrument capture sent to the bench",
    methods: ["POST"],
    path: /\/modules\/digifab\/bench\/?$/,
    limit: "8mb",
    example: "POST /api/v1/orgs/:slug/modules/digifab/bench/",
    promisedIn: ["modules/digifab/src/bench-model.ts"],
  },
  {
    name: "an action carrying files: a board's BOM and positions, a production photo",
    methods: ["POST"],
    path: /^\/api\/v1\/orgs\/[^/]+\/actions\/invoke$/,
    limit: "12mb",
    example: "POST /api/v1/orgs/:slug/actions/invoke",
    promisedIn: ["modules/builds/src/board-revision.ts", "modules/digifab/src/families/production/production-actions.ts"],
  },
];

export const bytesOf = (limit: string): number => Number.parseFloat(limit) * 1024 * 1024;

/** What to tell a caller whose body never got as far as a route. */
export function unreadableBody(err: unknown): { status: number; code: string; message: string } | null {
  const { type, limit } = err as { type?: unknown; limit?: unknown };
  if (type === "entity.too.large") {
    const most = typeof limit === "number" ? `${Math.round((limit / 1024 / 1024) * 10) / 10} MB` : "this size";
    return { status: 413, code: "body_too_large", message: `That is too much to send in one go: the most this takes is ${most}. Send less, or split it up.` };
  }
  if (type === "entity.parse.failed") return { status: 400, code: "invalid_json", message: "The request body is not valid JSON." };
  if (type === "encoding.unsupported" || type === "charset.unsupported") return { status: 415, code: "unsupported_body", message: "The request body is in an encoding this does not read." };
  return null;
}
