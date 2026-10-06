// cobblr-floorplan/1: a whole house (or workshop) as one JSON file, the shape
// any AI or person can write and Cobblr imports as it is.
//
// It is the floor plan's own model written out (docs/design-decisions/
// location-floor-plan.md): integers in mm; on a floor, x to the right and y
// down from the room's top-left corner, w × d; on a front face, w × h. The
// zod schema below is the one source: the importer validates with it, the
// TypeScript type is inferred from it, and the published JSON Schema is made
// from it (floorplanJsonSchema), so the three cannot drift.

import { z } from "zod";

export const FLOORPLAN_FORMAT = "cobblr-floorplan/1";

/** A length: a number of mm. A fraction is rounded; a person's AI writes 1219.2. */
const mm = (what: string) => z.number({ invalid_type_error: `${what} is a number of millimetres` }).finite();
const size = (what: string) => mm(what).positive(`${what} is more than 0`);
const name = z.string().trim().min(1, "a name is not empty").max(200);

export const FloorplanOpening = z.object({
  at_mm: mm("at_mm").min(0).describe("How far along the wall from its first end, in mm."),
  w_mm: size("w_mm").describe("Its width, in mm."),
  kind: z.enum(["door", "window", "opening"]).optional().describe("door, window or opening."),
});

export const FloorplanWall = z.object({
  x1: mm("x1"),
  y1: mm("y1"),
  x2: mm("x2"),
  y2: mm("y2"),
  openings: z.array(FloorplanOpening).optional(),
});

export const FloorplanZone = z.object({
  name,
  x_mm: mm("x_mm"),
  y_mm: mm("y_mm"),
  w_mm: size("w_mm"),
  d_mm: size("d_mm"),
});

export const FloorplanShelf = z.object({
  name,
  from_bottom_mm: mm("from_bottom_mm").min(0).describe("The height of the shelf's surface above the floor, in mm."),
});

export interface FloorplanContainerT {
  name: string;
  x_mm: number;
  y_mm: number;
  w_mm: number;
  d_mm: number;
  h_mm?: number;
  wall_mounted?: boolean;
  face?: { shelves?: Array<{ name: string; from_bottom_mm: number }> };
  containers?: FloorplanContainerT[];
}

/** A rack, cabinet or toolbox on a floor (x, y, w, d), or a drawer or bin on
 *  its parent's front face (x, y, w, d there, d being its height). */
export const FloorplanContainer: z.ZodType<FloorplanContainerT> = z.lazy(() =>
  z.object({
    name,
    x_mm: mm("x_mm"),
    y_mm: mm("y_mm"),
    w_mm: size("w_mm"),
    d_mm: size("d_mm"),
    h_mm: size("h_mm").optional().describe("Its height, in mm: the height of its front face."),
    wall_mounted: z.boolean().optional(),
    face: z.object({ shelves: z.array(FloorplanShelf).optional() }).optional(),
    containers: z.array(FloorplanContainer).optional(),
  }),
);

export const FloorplanRoom = z.object({
  name,
  level: name.optional().describe("The floor or level it is on (an area that groups rooms)."),
  w_mm: size("w_mm").describe("Its width, left to right, in mm."),
  d_mm: size("d_mm").describe("Its depth, top to bottom, in mm."),
  walls: z.array(FloorplanWall).optional(),
  zones: z.array(FloorplanZone).optional(),
  containers: z.array(FloorplanContainer).optional(),
});

export const FloorplanFile = z.object({
  format: z.literal(FLOORPLAN_FORMAT, { errorMap: () => ({ message: `format is "${FLOORPLAN_FORMAT}"` }) }),
  units_entered: z.enum(["mm", "cm", "m", "in", "ft"]).optional(),
  site: z.object({ name }).optional(),
  rooms: z.array(FloorplanRoom).min(1, "rooms lists at least one room"),
});

export type FloorplanFileT = z.infer<typeof FloorplanFile>;
export type FloorplanRoomT = z.infer<typeof FloorplanRoom>;

// ── the JSON Schema, made from the zod schema ──

type Json = Record<string, unknown>;

/** The subset of zod this format uses, as JSON Schema (draft 2020-12). A
 *  lazy schema becomes a named `$defs` entry, so the recursion stays. */
function toJson(t: z.ZodTypeAny, defs: Map<z.ZodTypeAny, string>, out: Json): Json {
  const desc = t.description ? { description: t.description } : {};
  const def = t._def as { typeName: string } & Record<string, unknown>;
  switch (def.typeName) {
    case "ZodLazy": {
      const named = defs.get(t);
      if (!named) throw new Error("floorplanJsonSchema: an unnamed lazy schema");
      if (!out[named]) {
        out[named] = {};
        out[named] = toJson((def.getter as () => z.ZodTypeAny)(), defs, out);
      }
      return { $ref: `#/$defs/${named}`, ...desc };
    }
    case "ZodObject": {
      const shape = (t as z.ZodObject<z.ZodRawShape>).shape;
      const properties: Json = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(shape)) {
        properties[k] = toJson(v as z.ZodTypeAny, defs, out);
        if (!(v as z.ZodTypeAny).isOptional()) required.push(k);
      }
      // Keys the format does not name are ignored on import, never refused,
      // so the schema allows them too: a file another AI annotated still reads.
      return { type: "object", properties, ...(required.length ? { required } : {}), ...desc };
    }
    case "ZodArray": {
      const min = (def.minLength as { value: number } | null)?.value;
      return { type: "array", items: toJson(def.type as z.ZodTypeAny, defs, out), ...(min ? { minItems: min } : {}), ...desc };
    }
    case "ZodOptional":
      return { ...toJson(def.innerType as z.ZodTypeAny, defs, out), ...desc };
    case "ZodString": {
      const checks = def.checks as Array<{ kind: string; value?: number }>;
      const min = checks.find((c) => c.kind === "min")?.value;
      const max = checks.find((c) => c.kind === "max")?.value;
      return { type: "string", ...(min !== undefined ? { minLength: min } : {}), ...(max !== undefined ? { maxLength: max } : {}), ...desc };
    }
    case "ZodNumber": {
      const checks = def.checks as Array<{ kind: string; value?: number; inclusive?: boolean }>;
      const min = checks.find((c) => c.kind === "min");
      return {
        type: "number",
        ...(min ? (min.inclusive ? { minimum: min.value } : { exclusiveMinimum: min.value }) : {}),
        ...desc,
      };
    }
    case "ZodBoolean":
      return { type: "boolean", ...desc };
    case "ZodEnum":
      return { type: "string", enum: def.values as string[], ...desc };
    case "ZodLiteral":
      return { const: def.value, ...desc };
    default:
      throw new Error(`floorplanJsonSchema: ${def.typeName} is not mapped`);
  }
}

/** The published JSON Schema of cobblr-floorplan/1. */
export function floorplanJsonSchema(): Json {
  const $defs: Json = {};
  const root = toJson(FloorplanFile, new Map<z.ZodTypeAny, string>([[FloorplanContainer, "container"]]), $defs);
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://docs.cobblr.xyz/schemas/cobblr-floorplan-1.json",
    title: "cobblr-floorplan/1",
    description:
      "A home or workshop as Cobblr's floor plan: rooms with their size, interior walls and openings, zones, and containers (racks, cabinets, toolboxes) with their shelves and drawers. Integers in millimetres; x right and y down from a room's top-left corner.",
    ...root,
    $defs,
  };
}

// ── reading a file: what is wrong with it, by line and field ──

/** The line a JSON path starts on in the text (1-based), or null. A small
 *  scanner: it follows keys and array positions through the text. */
export function lineOfPath(text: string, path: ReadonlyArray<string | number>): number | null {
  let i = 0;
  let line = 1;
  const ws = () => {
    while (i < text.length && /\s/.test(text[i]!)) {
      if (text[i] === "\n") line++;
      i++;
    }
  };
  const str = (): string => {
    let s = "";
    i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\\") i++;
      s += text[i];
      i++;
    }
    i++;
    return s;
  };
  const skip = (): void => {
    ws();
    const c = text[i];
    if (c === '"') return void str();
    if (c === "{" || c === "[") {
      const close = c === "{" ? "}" : "]";
      i++;
      ws();
      if (text[i] === close) return void i++;
      for (;;) {
        ws();
        if (c === "{") {
          str();
          ws();
          i++;
        }
        skip();
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        i++;
        return;
      }
    }
    while (i < text.length && !/[,\]}\s]/.test(text[i]!)) i++;
  };
  const find = (depth: number): number | null => {
    ws();
    if (depth === path.length) return line;
    const want = path[depth]!;
    const c = text[i];
    if (c === "{" && typeof want === "string") {
      i++;
      for (;;) {
        ws();
        if (text[i] === "}") return null;
        const k = str();
        ws();
        i++;
        if (k === want) return find(depth + 1);
        skip();
        ws();
        if (text[i] === ",") i++;
        else return null;
      }
    }
    if (c === "[" && typeof want === "number") {
      i++;
      for (let n = 0; ; n++) {
        ws();
        if (text[i] === "]") return null;
        if (n === want) return find(depth + 1);
        skip();
        ws();
        if (text[i] === ",") i++;
        else return null;
      }
    }
    return null;
  };
  try {
    return find(0);
  } catch {
    return null;
  }
}

export interface FloorplanProblem {
  /** "rooms[0].containers[2].w_mm" */
  field: string;
  line: number | null;
  message: string;
}

/** Read a file's text: the plan, or every problem with the line and field it
 *  is on. Never throws. */
export function readFloorplanFile(input: string | unknown): { plan: FloorplanFileT; problems: [] } | { plan: null; problems: FloorplanProblem[] } {
  let text: string | null = null;
  let raw: unknown = input;
  if (typeof input === "string") {
    text = input;
    try {
      raw = JSON.parse(input);
    } catch (e) {
      const at = /position (\d+)/.exec(String((e as Error).message));
      const line = at ? input.slice(0, Number(at[1])).split("\n").length : null;
      return { plan: null, problems: [{ field: "", line, message: `This is not JSON: ${(e as Error).message}` }] };
    }
  }
  const parsed = FloorplanFile.safeParse(raw);
  if (parsed.success) return { plan: parsed.data, problems: [] };
  const problems = parsed.error.issues.slice(0, 20).map((iss) => {
    const field = iss.path.map((p, n) => (typeof p === "number" ? `[${p}]` : `${n ? "." : ""}${p}`)).join("");
    return { field, line: text ? lineOfPath(text, iss.path) : null, message: iss.message };
  });
  return { plan: null, problems };
}

/** A problem as a person reads it: "line 14, rooms[0].w_mm: w_mm is more than 0". */
export function problemSentence(p: FloorplanProblem): string {
  return [p.line ? `line ${p.line}` : null, p.field || null].filter(Boolean).join(", ") + (p.line || p.field ? ": " : "") + p.message;
}

/** The prompt a person hands any AI to get their home as this format. The
 *  Copy a prompt button copies it and the docs print it (a test holds the
 *  docs to this text), so there is one prompt. */
export const FLOORPLAN_PROMPT = `I want a floor plan of my home or workshop as JSON in the "cobblr-floorplan/1" format, so I can import it into Cobblr. The format's JSON Schema is at https://docs.cobblr.xyz/schemas/cobblr-floorplan-1.json.

Ask me about each room one at a time until you have enough to draw it: its name, its floor or level, its size, where the doors and windows are, any interior walls, and the furniture or storage I want shown (shelving units, racks, cabinets, workbenches, toolboxes), with their sizes, where they stand, and their shelves or drawers. Use your best estimate when I'm vague, and tell me what you estimated.

Then output ONE JSON object, and nothing else, following these rules exactly:
- All measurements are integers in millimetres. Convert my feet and inches (1 in = 25.4 mm, 1 ft = 304.8 mm) and set "units_entered" to the unit I used.
- Each room has its own coordinates: x goes right and y goes down from the room's top-left corner, as if seen from above with the room's entry wall at the bottom.
- A room's "w_mm" is its width (left to right) and "d_mm" its depth (top to bottom). Its outer walls are implied; "walls" lists only interior walls, as segments from (x1, y1) to (x2, y2).
- Doors, windows and openings belong to a wall: "at_mm" is the distance from the wall's first end, "w_mm" is their width, and "kind" is "door", "window" or "opening". For an outer wall, add it to "walls" along the room's edge (e.g. y1 = y2 = d_mm for the bottom wall).
- "zones" are named regions of a room's floor (e.g. "Bench side"); "containers" are physical things that hold stuff (racks, shelves, cabinets, toolboxes), each with x_mm, y_mm (top-left corner), w_mm (width), d_mm (depth), h_mm (height) and "wall_mounted".
- A container's shelves go in "face": "shelves", each with "name" and "from_bottom_mm" (the height of the shelf's surface above the floor). Drawers or bins inside a container go in its own "containers" list, placed on its front face: x_mm from its left, y_mm down from its top, w_mm wide and d_mm tall.
- Every name must be unique within its parent. Don't invent rooms or furniture I didn't mention.

The shape:
{
  "format": "cobblr-floorplan/1",
  "units_entered": "ft",
  "site": { "name": "House" },
  "rooms": [
    {
      "name": "Printer room", "level": "Basement",
      "w_mm": 4267, "d_mm": 3048,
      "walls": [ { "x1": 0, "y1": 3048, "x2": 4267, "y2": 3048,
                   "openings": [ { "at_mm": 300, "w_mm": 815, "kind": "door" } ] } ],
      "zones": [ { "name": "Bench side", "x_mm": 0, "y_mm": 0, "w_mm": 1500, "d_mm": 3048 } ],
      "containers": [
        { "name": "Rack 1", "x_mm": 100, "y_mm": 100, "w_mm": 1220, "d_mm": 610, "h_mm": 1830,
          "wall_mounted": false,
          "face": { "shelves": [ { "name": "Shelf 1", "from_bottom_mm": 150 },
                                  { "name": "Shelf 2", "from_bottom_mm": 600 } ] },
          "containers": [] }
      ]
    }
  ]
}

Before the JSON, list your assumptions in one short paragraph. After it, say nothing.`;
