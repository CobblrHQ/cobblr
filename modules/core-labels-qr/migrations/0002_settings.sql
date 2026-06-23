-- Per-workspace QR settings. One row per workspace.
--
-- token_style controls what a freshly-minted QR encodes:
--   'descriptive' (default) — /qr/<kind>/<id>: self-describing + portable,
--                  survives a dead instance + route changes. Denser code.
--   'opaque'      — /qr/<random>: short + reveals nothing (privacy, tiny
--                  labels). The legacy behaviour. Both resolve identically;
--                  anything already printed keeps working.

create table core_labels_qr_settings (
  id          integer primary key default 1 check (id = 1), -- singleton row
  token_style text not null default 'descriptive'
              check (token_style in ('descriptive', 'opaque')),
  updated_at  timestamptz not null default now()
);

insert into core_labels_qr_settings (id) values (1) on conflict do nothing;
