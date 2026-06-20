-- core_scan_qr_rules — the per-workspace "external QR resolver" redirect table.
--
-- A scanned FOREIGN QR payload (a companion app URL like
-- https://wos.host/inventory/<slug>, a bare Homebox number, …) is matched against
-- these rules top-down; the first match extracts a key and resolves it to a
-- Cobblr entity, then the scan behaves exactly like a native one (open the
-- entity's detail page). OPT-IN: zero rows ⇒ the resolver is inert and scans
-- flow through the normal barcode/identify routine unchanged.
--
-- See docs/design-decisions/external-qr-resolver.md.
--
-- manual recovery if this fails partway:
--   DROP TABLE IF EXISTS core_scan_qr_rules;
--   DELETE FROM _prisma_migrations WHERE migration_name = '0004_qr_rules';

create table core_scan_qr_rules (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  enabled      boolean not null default true,
  position     integer not null default 0,

  -- how to RECOGNISE the format:
  --   { "type": "url_prefix", "value": "https://wos.host/inventory/" }
  --   { "type": "regex",      "value": "^https?://wos\\.host/(?<type>[^/]+)/(?<key>[^/]+)" }
  --   { "type": "bare",       "value": "^\\d+$" }   // payload is a plain number
  match_spec   jsonb not null,

  -- how to EXTRACT the key (and optional entity type) from the payload:
  --   { "source": "path_segment_after_prefix" | "capture_group" | "whole_value",
  --     "group": "key", "type_from": "type",
  --     "transform": ["trim","strip_leading_zeros","lowercase"] }
  extract_spec jsonb not null default '{}'::jsonb,

  -- how to RESOLVE the key to a Cobblr entity:
  --   { "target_kind": "inventory:part",            // fixed kind, OR
  --     "type_map": { "inventory": "inventory:part", "printers": "machines:machine" },
  --     "key_field": "wos_id" }   // native column OR metadata key the entity carries
  resolve_spec jsonb not null,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ordered evaluation: lowest position first, then insertion order
create index core_scan_qr_rules_order_idx on core_scan_qr_rules (position, created_at);
