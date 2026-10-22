import { z } from "zod";
import { EntityField, EntityKindIdRegex } from "@cobblr/platform-contract/entity-fields";
import { PresetNameSchema, RawTraits } from "@cobblr/platform-contract/traits";

export const EntityKind = z
  .object({
    id: z
      .string()
      .regex(EntityKindIdRegex, "entity kind id must be <module>:<name>"),
    displayName: z.string().min(1),
    displayNamePlural: z.string().optional(),
    icon: z.string().optional(),
    fields: z.array(EntityField).default([]),
    // Cross-module read whitelist — see docs/architecture/entity-resolver.md.
    // Field names other modules' renderers can read via platform.entities.lookup()
    // / the resolver. The kernel projects ResolvedEntity.fields to this list
    // before returning to a foreign caller; anything not declared is private
    // to the owning module.
    //
    // Implicit always-exposable: `id`, `title`, `subtitle`, `image_path`,
    // `detailUrl` (the cross-cutting display props on ResolvedEntity itself).
    //
    // Default behaviour when omitted: legacy — full ResolvedEntity.fields
    // is returned and a one-time deprecation warning is logged per kind.
    // New modules SHOULD declare exposableFields.
    // What "the same place" means for this kind, when deciding whether two
    // records are duplicates of each other. The field name that scopes it
    // (`parent_id` for locations, `location_id` for parts), or "workspace" for
    // a kind where two of the same title anywhere is a duplicate.
    //
    // ABSENT MEANS NOT DEDUPLICATED, deliberately. Two assets called "Drill"
    // are usually two drills; two projects called "Kitchen" are usually a
    // rename in progress. Guessing that same-title means same-thing is exactly
    // the guess that deletes somebody's work, so a kind opts IN by saying how
    // it should be read.
    duplicateScope: z.union([z.literal("workspace"), z.string().min(1)]).optional(),
    // The kind whose records are THIS kind's own categories (inventory:part's
    // is inventory:category: a table of categories, a category_id on the
    // record, a filter in its list). The platform's scan category axis on such
    // a kind is a second question with the same name; it is labelled as
    // scanning's so a form does not ask "Category" twice, until the two are
    // joined into one axis that reads and grows these records.
    categoryAxis: z.string().min(1).optional(),
    // A native text field on the record that IS this kind's category
    // (assets:asset's `type`, "Type / category" on its form). The scan
    // category axis answers from it instead of adding a "Category" custom
    // field beside it, so a record has one category whether it was scanned
    // or typed. A kind declares this or `categoryAxis`, never both.
    categoryField: z.string().min(1).optional(),
    exposableFields: z.array(z.string().min(1)).optional(),
    // Fields the MEMBER'S OWN ASSISTANT may read beyond exposableFields (Cobb,
    // or an MCP client acting as that member): what a person wrote for
    // themselves, like a part's notes, that they can already read in the app.
    // Never to other modules, shares or other workspaces, and still under
    // fieldReadScopes. The AI settings tell the person their assistant reads
    // them (#4798).
    assistantReadableFields: z.array(z.string().min(1)).optional(),
    // Per-field read-scope (H2): map a field name to the capability
    // (action_id) a viewer must hold to read it. Layered ON TOP of
    // exposableFields — a field must be exposable AND (if listed here)
    // the viewer must hold its capability, else the kernel omits it
    // from the read. Owner/admin and viewer-less internal reads see
    // everything; the member-facing views/portal path passes the
    // viewer. Enables tiered member access ("Tier 1 sees parts, not
    // prices"). The capability should be a grantable action so admins
    // can assign it via roles / the permission matrix.
    fieldReadScopes: z.record(z.string().min(1), z.string().min(1)).optional(),
    // Path template (relative to PUBLIC_BASE_URL) for the entity's
    // canonical detail page. {id} placeholder gets substituted.
    detailRoute: z.string().optional(),
    // Module-relative GET endpoint for lookup. {id} placeholder.
    // The platform proxies to this when other modules ask for the
    // entity's data via platform.entities.lookup().
    getEndpoint: z.string().optional(),
    // Module-relative POST collection endpoint that creates one record of this
    // kind (e.g. "/entries"). Declaring it makes the kind creatable by generic
    // callers — the Ask Cobb chat's create proposals + the workspace-tools
    // registry (in-app tool loop + MCP). Only declare it when the plain
    // collection POST accepts a simple fields body; leave unset for kinds
    // created via actions/wizards.
    createEndpoint: z.string().optional(),
    // Module-relative PATCH endpoint that partially updates one record
    // (e.g. "/entries/{id}"). Same contract as createEndpoint: declaring it
    // makes the kind updatable by generic callers; the PATCH must accept a
    // partial fields body.
    updateEndpoint: z.string().optional(),
    // Module-relative DELETE endpoint for one record (e.g. "/entries/{id}").
    // Declaring it makes the kind deletable by generic callers.
    deleteEndpoint: z.string().optional(),
    // Who may delete one: a role floor ("member", "admin") or a capability
    // id. Required with deleteEndpoint. The kernel holds every DELETE on the
    // endpoint to it, and /entity-kinds answers can_delete per viewer from
    // it, so the record's button, the assistant and the door read one rule.
    deleteBy: z.string().optional(),
    // THE module's primary kind — the entity its instance-scoped item routes
    // (/orgs/:slug/instances/:name/items) dispatch to (primaryRouter). At most
    // one kind per module declares it. Instance-kind synthesis copies the
    // primary kind's shape (fields/traits/endpoints) for each named instance;
    // a multi module without a declared primary simply gets no synthesized
    // instance kinds (honest opt-in, never guessed — sales' FIRST kind is
    // customer but its primary is order, so declaration order can't be trusted).
    primary: z.boolean().optional(),
    // Module-relative GET collection endpoint listing this kind's records
    // (e.g. "/entries") — the module's OWN full-fat list, enforcing its own
    // role gating. Declaring it lets FIRST-PARTY generic surfaces (the floor
    // plan's entity occupants, future pickers) enumerate rows with the fields
    // the module's own pages see (location_id, metadata, image_path) — data
    // the exposableFields-projected /entities/:kind list deliberately hides
    // from foreign/member callers. Response contract: { items: [...] } where
    // rows carry at least id + the kind's declared fields.
    listEndpoint: z.string().optional(),
    version: z.string().optional(),
    // Cross-module trait declarations. Three mutually-exclusive
    // forms:
    //   1. raw — `traits: { tangibility: "physical", ... }`
    //   2. preset — `profile: "owned-thing"`
    //   3. preset + override — `profile: "owned-thing", overrides: { lifecycle: "completable" }`
    // `defineModule()` resolves form 2/3 into form 1 at load time so
    // downstream code only ever reads `traits`.
    traits: RawTraits.optional(),
    profile: PresetNameSchema.optional(),
    overrides: RawTraits.optional(),
    // Labeling hint (read generically by the `labels` module via the kernel
    // entity-kind registry — NOT a labels-specific coupling). Whether a
    // printed label draws the human-readable code in the QR center DEFAULTS
    // to this per-kind value when the workspace hasn't set an explicit
    // toggle. Omitted => true (today's behavior). A kind sets it `false`
    // when its entities are name-unique / non-enumerable enough that a
    // disambiguating code is noise — e.g. a location ("the Office"), unlike
    // "monitor 5 of 17". Any module may declare it; a generic extension
    // point, not a special case. A user's explicit per-kind toggle still
    // wins over this default. See docs/design-decisions/label-codes.md.
    labelCodeOverlayDefault: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.traits && data.profile) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `entity kind '${data.id}': cannot use both 'traits' (raw) and 'profile' (preset) at once — pick one`,
        path: ["profile"],
      });
    }
    if (data.overrides && !data.profile) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `entity kind '${data.id}': 'overrides' only makes sense alongside 'profile'`,
        path: ["overrides"],
      });
    }
    // exposableFields must reference declared field names (or the
    // implicit-always-exposable cross-cutting props on ResolvedEntity).
    if (data.exposableFields) {
      const declared = new Set(data.fields.map((f) => f.name));
      const implicit = new Set([
        "id",
        "title",
        "subtitle",
        "image_path",
        "detailUrl",
      ]);
      for (const name of data.exposableFields) {
        if (!declared.has(name) && !implicit.has(name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `entity kind '${data.id}': exposableFields references '${name}' which is neither a declared field nor an implicit cross-cutting prop (id/title/subtitle/image_path/detailUrl)`,
            path: ["exposableFields"],
          });
        }
      }
    }
    // fieldReadScopes keys must be declared fields, and a gated field
    // should also be exposable — gating a field the whitelist already
    // hides is a no-op and almost always a mistake.
    if (data.fieldReadScopes) {
      const declared = new Set(data.fields.map((f) => f.name));
      const exposable = data.exposableFields
        ? new Set(data.exposableFields)
        : null;
      for (const name of Object.keys(data.fieldReadScopes)) {
        if (!declared.has(name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `entity kind '${data.id}': fieldReadScopes gates '${name}', which is not a declared field`,
            path: ["fieldReadScopes"],
          });
        } else if (exposable && !exposable.has(name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `entity kind '${data.id}': fieldReadScopes gates '${name}' but it isn't in exposableFields, so the whitelist already hides it — add it to exposableFields or drop the scope`,
            path: ["fieldReadScopes"],
          });
        }
      }
    }
  });
