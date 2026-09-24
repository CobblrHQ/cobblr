# Sandbox seeds

What a fresh `GET /try` sandbox has in it. Each file is a **blueprint** — the
same format `signup_invites.blueprint` carries and `applyBlueprint` reads, so a
seed can turn on modules, create instances and install bundles without any code.

Pick one with `TRY_SANDBOX_SEED=<name>` on the box, or per link with
`GET /try?seed=<name>` (the name is validated against `^[a-z0-9][a-z0-9-]*$`
and only ever resolved inside this directory — it can arrive from a query
string, so it must never be able to name a path).

A missing or malformed seed is logged and skipped: the visitor gets an
empty-but-working sandbox, never no sandbox. See
`docs/design-decisions/try-sandbox.md`.

Why seed at all: an empty table is the wrong first impression, which is the
lesson the household demo taught — invented names behind grey placeholder
tiles read as a demo, a shelf of books you recognise reads as a workspace.

## Bundle versions come from the catalog, not the seed

A blueprint embeds each bundle's full manifest as it was when it was written, so
a seed left alone goes on installing old versions while `bundles/` moves on.
`seedSandbox` swaps each embedded bundle for the manifest this image ships
(`withCurrentBundles`, `localFlagshipManifest`), so a new sandbox always starts
on the current version and never opens on "Update now". A bundle the catalog
does not carry keeps the seed's own copy. A sandbox also never shows an update
prompt (`useBundleUpdates` is empty there): a visitor has an hour and did not
choose these bundles. Both are held by `a-fresh-sandbox-installs-the-current-bundles`
(api) and `a-sandbox-never-offers-a-bundle-update` (web).
