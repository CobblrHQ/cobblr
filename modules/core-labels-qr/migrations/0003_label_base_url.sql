-- Per-workspace custom base URL for printed QR labels.
--
-- Why: a printed QR encodes a full URL (e.g. https://cobblr.me/qr/<token>).
-- If the workspace later moves — self-hosts, changes domains, or leaves the
-- hosted instance — every already-printed code points at a dead origin.
--
-- Fix: let the workspace encode a STABLE base of its own — a domain, a DuckDNS
-- name, or a Tailscale MagicDNS name — that it controls and forwards to
-- whatever instance is live right now. Move the instance later → re-point the
-- forward, and every printed code keeps resolving. The /qr/<token> path is the
-- stable contract; the forward must be path-preserving (an HTTP redirect or a
-- tiny reverse proxy, NOT a bare DNS CNAME — the instance routes by Host + TLS).
--
-- null / empty  → encode against the serving origin (today's behaviour).
-- set           → new codes + the PNG render encode <label_base_url>/qr/<token>.
-- Already-printed codes are unaffected either way (they carry whatever base was
-- live when printed) — this only changes what freshly-minted labels encode.

alter table core_labels_qr_settings
  add column label_base_url text;
