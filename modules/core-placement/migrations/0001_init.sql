-- Placement — the containment primitive (tenant-local).
--
-- "(containee_kind, containee_id) lives inside (container_kind, container_id)."
-- A generic, kind-agnostic answer to "what is this thing inside of?" — a part
-- installed in a machine, a component in a server (asset), an item filed into a
-- location. ONE relationship for the whole platform; a Location becomes just one
-- KIND of container (see docs/design-decisions/placement-and-containment.md).
--
-- Tenant-local (no org_id — the tenant DB *is* the org, like
-- core_locations_locations) because placement replaces the hot, tenant-local
-- location_id and must sit beside the entities it links for same-DB joins +
-- atomic backfill. placed_by is a bare uuid: users live in cobblr_meta, not the
-- tenant DB, so no FK.
--
-- Invariant: a containee is in AT MOST ONE container (a thing is in one place),
-- enforced by the unique constraint; a container holds many. Trait-gating (only
-- physical things may contain / be contained) and the cycle-guard live in
-- platform().placement, not the schema.

create table core_placement_placements (
  id              uuid primary key default gen_random_uuid(),
  -- The contained thing. Kind is "<module>:<thing>" (or "<instance>:item"),
  -- matching the entity-kind registry; id is whatever the kind uses.
  containee_kind  text not null,
  containee_id    text not null,
  -- The container it lives inside (same polymorphic shape).
  container_kind  text not null,
  container_id    text not null,
  -- Optional slot/position within the container (a PCIe slot, a shelf).
  slot            text,
  metadata        jsonb not null default '{}'::jsonb,
  placed_at       timestamptz not null default now(),
  placed_by       uuid,
  -- One container per containee: a thing is in exactly one place.
  constraint core_placement_one_container unique (containee_kind, containee_id)
);

-- Fast reverse lookup: "what are the contents of this container?"
create index core_placement_container_idx
  on core_placement_placements(container_kind, container_id);

-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS core_placement_placements;
