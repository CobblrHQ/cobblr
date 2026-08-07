# Self-hosting Cobblr

Run Cobblr on your own machine, on your own network, with nothing but Docker.
No account, no cloud, no subscription. This guide gets you to a working
instance you can open from your phone - **including the camera**, which is the
one part that needs a little care.

## Two install paths

- **Image-based (two files, no build)** -
  [`deploy/selfhost/standalone/`](./deploy/selfhost/standalone/README.md): a
  compose file + a `.env`, pulling prebuilt multi-arch images (amd64 + arm64,
  so a Raspberry Pi runs the same file). Updates are `docker compose pull`,
  including across PostgreSQL majors. **This becomes the recommended path when
  the public images open** alongside the first public release; the README
  there says whether they are live yet.
- **Clone-and-build** - the rest of this guide. Build the images from this
  repository yourself; always available, and what the image path falls back
  to today.

Everything below (HTTPS modes, privacy knobs, backups) applies to both paths.

## Why HTTPS is not optional (the camera)

Browsers only allow a web app to use the **camera or microphone** in a *secure
context* - that means **HTTPS**, or `localhost`. A plain address like
`http://192.168.1.50:8088` is *not* secure, so the browser silently refuses the
camera. There is no setting or flag that changes this on a phone; it's a
browser rule, not a Cobblr one.

So to scan barcodes or take photos from your phone, Cobblr has to be served
over HTTPS. The good news: you can get **real, trusted HTTPS on a purely local
box, for free, without forwarding any ports or buying a domain.** That's what
the bundled Caddy proxy does.

You have a few options, easiest first:

| Option | Cost | Phone setup | Needs |
|---|---|---|---|
| **DuckDNS** (recommended) | free | none | a free subdomain + outbound internet |
| **Cloudflare** | free | none | your own domain on Cloudflare DNS |
| **Tailscale** (our favorite - remote access too) | free | install the app once | a tailnet |
| **Offline / `tls internal`** | free | install a cert on each device | nothing |

DuckDNS, Cloudflare, and Tailscale each give a **publicly-trusted certificate**,
so your phone just works - nothing to install. DuckDNS and Cloudflare stay
entirely on your LAN; the box only needs *outbound* internet to prove it owns
the name (a DNS challenge - no ports opened, nothing exposed to the internet).
Tailscale reaches your box over your private tailnet, so it also works away from
home.

## Prerequisites

- A machine on your LAN with **Docker + Docker Compose** (Linux, a Mac, a NAS,
  a Raspberry Pi 4/5, an old laptop - anything that runs Docker).
- Its LAN IP (e.g. `192.168.1.50`). Give it a DHCP reservation so it doesn't
  change.

## Quick start (DuckDNS - recommended)

1. **Claim a free subdomain.** Go to [duckdns.org](https://www.duckdns.org),
   sign in, pick a name (e.g. `myshop` → `myshop.duckdns.org`), and set its
   IP to your box's **LAN IP** (yes, a public DNS name is allowed to point at a
   `192.168.x.x` address). Copy your **token**.

2. **Clone and configure.**
   ```bash
   git clone <this-repo> cobblr && cd cobblr
   cp deploy/selfhost/.env.example .env
   ```
   Edit `.env`:
   - `COBBLR_SITE_ADDRESS=myshop.duckdns.org`
   - `DUCKDNS_TOKEN=<your token>`
   - `SUPERADMIN_EMAILS=<your email>` so your account is also the instance operator
     (the `/admin` console, above every workspace)
   - Generate the secrets it asks for (`openssl rand -hex 32` for `JWT_SECRET`,
     `openssl rand -hex 16` for `TENANT_CREDS_ENCRYPTION_KEY`), and set a real
     `POSTGRES_PASSWORD` (matching it in the two `DATABASE_URL`s).

3. **Bring it up.**
   ```bash
   docker compose -f docker-compose.yml -f deploy/selfhost/docker-compose.selfhost.yml up -d --build
   ```
   First run builds the images and requests the certificate (a few minutes).

4. **Open it** at `https://myshop.duckdns.org` - from your laptop *and* your
   phone (both on the same LAN). Create your account (signup is open on first
   run). Test the camera in the scan/photo flow.

5. **Close signup.** Once your account exists, set `PUBLIC_SIGNUP_ENABLED=false`
   in `.env` and `docker compose ... up -d` again, so no one else can register.

## Cloudflare (your own domain)

If you own a domain and keep its DNS on Cloudflare (free plan):

1. Create a Cloudflare API token scoped **Zone → DNS → Edit** for your zone.
2. Add a DNS record `cobblr.yourdomain.com` → your box's LAN IP.
3. In `.env`:
   ```
   COBBLR_CADDYFILE=./deploy/selfhost/Caddyfile.cloudflare
   COBBLR_SITE_ADDRESS=cobblr.yourdomain.com
   CLOUDFLARE_API_TOKEN=<token>
   ```
4. Bring the stack up as above.

## Tailscale (our favorite - and it works away from home)

We run Cobblr's own hosted instances behind [Tailscale](https://tailscale.com)
and love it. If you already use it (or don't mind installing it), it gives you
real HTTPS **and** secure access from anywhere - not just your LAN - with nothing
to configure per device. Tailscale terminates TLS itself, so you skip the bundled
Caddy proxy here.

1. Install Tailscale on the box and on your phone/laptop, all signed into the
   same tailnet.
2. Bring up the stack **without** the self-host (Caddy) overlay - just the base
   compose, which serves the web UI on port `8088`:
   ```bash
   cp deploy/selfhost/.env.example .env    # still set the secrets: JWT_SECRET, TENANT_CREDS_ENCRYPTION_KEY, POSTGRES_PASSWORD
   docker compose up -d --build
   ```
3. Expose the web container over your tailnet with a real cert:
   ```bash
   sudo tailscale serve --bg 8088
   ```
   Tailscale prints an `https://<box>.<your-tailnet>.ts.net` URL.
4. Open that URL on your phone (with Tailscale connected). Real cert → the camera
   works, and it's reachable wherever you are, not only at home.

Trade-off vs. DuckDNS: every device that opens Cobblr must be on your tailnet
(install the app + sign in once). In return you get encrypted access from
anywhere, free. For a plain-LAN, no-account setup - a shared shop screen, a
guest's phone - DuckDNS (above) or the offline option (below) stay the right
pick. (The base compose also publishes Postgres/the API on the box's local ports
for convenience; on a shared machine, drop those `ports:` or firewall them.)

## Offline (no domain, no internet for TLS)

Fully air-gapped option. Caddy runs its own certificate authority; the cost is
that each device must trust that CA once.

1. In `.env`:
   ```
   COBBLR_CADDYFILE=./deploy/selfhost/Caddyfile.internal
   COBBLR_SITE_ADDRESS=192.168.1.50     # or a name like cobblr.local
   ```
2. Bring the stack up.
3. Export Caddy's root CA and install it on each phone/laptop:
   ```bash
   docker compose -f docker-compose.yml -f deploy/selfhost/docker-compose.selfhost.yml \
     exec caddy cat /data/caddy/pki/authorities/local/root.crt > cobblr-root.crt
   ```
   - **iOS:** AirDrop/email `cobblr-root.crt` to the phone → install the profile
     (Settings → General → VPN & Device Management), then **enable full trust**
     under Settings → General → About → Certificate Trust Settings.
   - **Android:** Settings → Security → Encryption & credentials → Install a
     certificate → CA certificate.

Prefer DuckDNS or Cloudflare if you can - they skip this entirely.

## Troubleshooting

- **Phone can't reach the DuckDNS name, laptop can.** Some routers and Pi-hole
  block public names that resolve to private IPs ("DNS rebind protection"). Add
  an exception for your DuckDNS name, or add a local DNS entry mapping the name
  to the LAN IP.
- **Certificate didn't issue.** Check `docker compose ... logs caddy`. Usual
  cause: wrong `DUCKDNS_TOKEN`/`CLOUDFLARE_API_TOKEN`, or the box has no
  outbound internet. Certs are cached under `./data/caddy` once issued.
- **Camera still blocked.** Confirm the address bar shows `https://` with no
  warning. On the offline option, the CA must be *trusted* (iOS: the extra
  Certificate Trust Settings toggle), not just installed.

## Updating

```bash
git pull
docker compose -f docker-compose.yml -f deploy/selfhost/docker-compose.selfhost.yml up -d --build
```
Database migrations run automatically on api start — including across
PostgreSQL major versions (the db image upgrades its own data directory in
place, leaving the old cluster untouched as the rollback).

**Updates are a one-way door.** Migrations are forward-only: moving to a newer
build is always supported, but going *back* to an older one can meet a database
the older code does not understand. If you track a bleeding-edge build, keep
backups (below) — rolling back means restoring one.

### Experimental modules

Modules marked `experimental` are rough, narrow, and may change or be removed.
They load by default so nothing ever vanishes from an existing install; set

```
COBBLR_DISABLE_EXPERIMENTAL_MODULES=true
```

in your `.env` to keep them out entirely (not loaded, not mounted, no
background workers). They show an amber "Experimental" badge in the module
picker either way.

## Backups

Your data lives in bind-mounted folders under `./data/` (Postgres, uploaded
files, installed modules, Caddy certs). Back up the whole `./data/` tree - a
copy of that directory is a complete backup. For database-only dumps:
```bash
docker compose -f docker-compose.yml -f deploy/selfhost/docker-compose.selfhost.yml \
  exec db pg_dumpall -U cobblr | gzip > cobblr-backup-$(date +%F).sql.gz
```

## Privacy - what leaves the box

Cobblr makes **no unsolicited phone-home**: nothing calls Cobblr's servers at
startup or on a schedule, there's no telemetry, analytics, error-reporting, or
update check to any external service. Your data stays in your Postgres. A few
*features* do reach third-party services **when you use them** - here's the full
outbound surface and how to turn each off.

| Feature | Contacts | Default | Turn off |
|---|---|---|---|
| **Barcode scanning** | upcitemdb, Open Food/Products/Beauty Facts, DuckDuckGo (+ go-upc if you opt in) | on when you scan | `COBBLR_SCAN_EXTERNAL_LOOKUPS=false` |
| **AI features** | your chosen LLM provider (OpenAI/Anthropic/…) | needs *your* key - nothing without one | `COBBLR_AI_ENABLED=false` |
| **Marketplace** | `api.github.com/CobblrHQ/cobblr-extensions` (the extension catalog) | only when you open the marketplace | `COBBLR_EXTENSIONS_URL=` your own, or don't open it |
| **TLS certificate** | Let's Encrypt / your DNS provider | on (unless the offline `tls internal` option) | use the offline option |

Everything else - Google-Drive backups, Discord/Slack notifications, an external
barcode resolver - is **off unless you configure it**.

### Barcode providers - fine-grained control

Each catalog provider is independently switchable, and you can supply your own
API key where one exists. Set these in `.env`:

| Var | Default | What it does |
|---|---|---|
| `COBBLR_SCAN_EXTERNAL_LOOKUPS` | `true` | Master switch - `false` means **no** third-party barcode calls at all. |
| `COBBLR_SCAN_OPENFACTS` | `true` | Open Food/Products/Beauty Facts (free, open data - the most privacy-friendly). |
| `COBBLR_SCAN_UPCITEMDB` | `true` | upcitemdb (free shared tier). |
| `COBBLR_SCAN_UPCITEMDB_KEY` | - | Your upcitemdb paid key → your own quota. |
| `COBBLR_SCAN_WEBSEARCH` | `true` | DuckDuckGo image/text fallback for codes no catalog knows. |
| `COBBLR_SCAN_GOUPC_API_KEY` | - | Your [go-upc](https://go-upc.com) API key → their **official API** (best coverage). |
| `COBBLR_SCAN_GOUPC` | `false` | Enable go-upc's HTML *scraper* (no key). Off by default - we don't ship a scraper that runs unasked; prefer the API key above. |

### Shared barcode intelligence (BIdb)

Cobblr can run a hosted, cross-install barcode database (BIdb) that serves known
results fast and pools opt-in corrections. It is **off by default** for
self-host. When you turn it on, a scanned barcode is sent to Cobblr's service,
which returns open-data and community-corrected results (never another provider's
licensed data). Your own providers above still handle anything BIdb doesn't know,
and if BIdb is unreachable the scan falls back to them.

| Var | Default | What it does |
|---|---|---|
| `COBBLR_BIDB_URL` | - | Set to `https://bidb.cobblr.xyz` to consult the shared database. Unset keeps the tier inert. |
| `COBBLR_BIDB_KEY` | - | Your per-install key (generated from a Cobblr account), sent as a bearer token. |

The full model (why a self-host install queries but never receives another
provider's licensed data, and the give-to-receive correction opt-in) is
documented on [docs.cobblr.xyz](https://docs.cobblr.xyz).

### Full air-gap

For an instance that makes **zero** outbound calls beyond TLS renewal:
```
COBBLR_AI_ENABLED=false
COBBLR_SCAN_EXTERNAL_LOOKUPS=false
COBBLR_EXTENSIONS_URL=          # and don't open the marketplace
```
Pair that with the offline **`tls internal`** option and the install is fully
local.
