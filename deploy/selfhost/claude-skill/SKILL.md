---
name: cobblr-selfhost
description: Install, verify, or repair a self-hosted Cobblr instance on this machine. Asks the three questions that cannot be guessed, generates the two files, brings the stack up, and proves it actually serves before saying it worked. Use when someone wants to self-host Cobblr, is stuck partway through an install, or has an instance that is not answering.
---

# Installing Cobblr on somebody's own machine

You are setting up software on hardware that belongs to the person you are
talking to, and some of what you do here cannot be undone by them later. Read
the two rules before the procedure.

**Rule 1: do not invent configuration.** Every environment variable, image
name, port and profile comes from the two canonical files you download in step
1. If you find yourself typing a variable name from memory, stop and grep the
downloaded `.env.example` for it. Variables that look plausible and do not
exist are the most common way an install ends up half-working, because nothing
reports them.

**Rule 2: one value is irrecoverable.** `TENANT_CREDS_ENCRYPTION_KEY` decrypts
every workspace's database credentials. Lose it and the data is gone in the
way that no backup fixes, because the backup is encrypted with it. Do not
finish the install until the person confirms they have stored it somewhere
outside the box.

## The three questions

Everything else has a correct default and you should not ask about it. Ask
these, in this order, and stop after them:

1. **What address will you open Cobblr at?** This decides the HTTPS path, so
   ask what they have rather than for a hostname: a Tailscale network, a domain
   they own, neither. Their answer maps to `COBBLR_TLS_MODE` (see step 2).
2. **What email address should be the operator?** It gets the admin console and
   the alerts. Without one there is no way to invite anyone later.
3. **Do you have a domain or tailnet certificate set up already?** Only if
   their first answer implies one. It decides whether you need a token.

Do not ask about ports, data directories, backup retention, the update
channel, or the AI settings. The defaults are right, and asking makes an
install feel like a configuration exercise.

## The camera, which is why HTTPS is not optional

Say this out loud before they choose, because it changes the answer: browsers
refuse camera access over plain HTTP, and scanning things with a phone is the
feature most people install Cobblr for. Plain HTTP is a fine choice for a
first look on a laptop and a bad one for the thing they actually want.

## Procedure

### 1. Get the two canonical files

```bash
mkdir -p ~/cobblr && cd ~/cobblr
curl -fsSLO https://docs.cobblr.xyz/self-host/docker-compose.yml
```

Read it. It is the source of truth for service names, profiles and every
variable you are allowed to set. The `.env.example` beside it in the source
repo is the annotated version of the same surface.

### 2. Write the `.env`

The web setup builder at https://docs.cobblr.xyz/setup-builder produces exactly
this file from the same three answers, and it is kept in step with the compose
file. **Prefer its output.** If the person is happy to open a browser, have
them use it and paste the result. Write the file yourself only when they
cannot, and then follow its shape.

Required, always:

```ini
COBBLR_SITE_ADDRESS=<the address from question 1, no https:// and no trailing slash>
SUPERADMIN_EMAILS=<the operator email from question 2>
POSTGRES_PASSWORD=<generate: openssl rand -hex 16>
JWT_SECRET=<generate: openssl rand -hex 32>
TENANT_CREDS_ENCRYPTION_KEY=<generate: openssl rand -hex 16>
PUBLIC_SIGNUP_ENABLED=true
```

Then the HTTPS block for their answer:

- **A Tailscale network** (nicest, works away from home):
  `COMPOSE_PROFILES=caddy`, `COBBLR_TLS_MODE=tsnet`. The address must be a name
  the node will own, `<something>.<their-tailnet>.ts.net`. **Read their tailnet
  name off the Tailscale admin console's DNS page rather than guessing its
  shape**, and confirm MagicDNS and HTTPS certificates are enabled there. A
  wrong tailnet produces a node that joins, reports Connected, and never gets a
  certificate, and the only symptom is the browser failing with
  `SSL_ERROR_INTERNAL_ERROR_ALERT`.
- **A domain on Cloudflare:** `COMPOSE_PROFILES=caddy`,
  `COBBLR_TLS_MODE=cloudflare`, plus `CLOUDFLARE_API_TOKEN` scoped to edit DNS
  for that zone. Reaching the box from outside also needs a port forward, which
  is a separate conversation and often the harder half.
- **Neither, LAN only:** `COMPOSE_PROFILES=caddy`, `COBBLR_TLS_MODE=internal`.
  Caddy runs its own certificate authority and each device trusts it once. The
  camera works after that.
- **Neither, and they want to look first:** `COMPOSE_PROFILES=`,
  `WEB_BIND=0.0.0.0`. Plain HTTP, no camera. Say so again here.

Recommended, and worth one sentence each rather than a question:

```ini
COBBLR_VERSION=nightly
COMPOSE_PROFILES=caddy,autoupdate
```

Cobblr is under active development, so nightly is where the fixes are, and the
`autoupdate` profile keeps the box on it by checking every four hours. Mention
that the updater needs the Docker socket, so it is theirs to decline.

### 3. Bring it up

```bash
docker compose up -d
```

First boot creates the database and runs migrations, so the api can take a
minute to turn healthy. That is normal and not a hang.

### 4. Prove it, do not assume it

Do not report success off `docker compose ps`. A container can be up and
serving nothing.

```bash
curl -fsS http://127.0.0.1:8088/api/v1/healthz    # bare/LAN installs
curl -fsS https://<their address>/api/v1/healthz  # once TLS is up
```

You want `"ok":true` and a `version`. Then, in order:

- **The web app itself answers**, not only the api: fetch `/` and confirm it
  returns the app shell rather than a proxy error.
- **On tsnet**, confirm a certificate actually issued. `docker compose logs
  caddy` reports when one never arrives and what to check. Do not skip this:
  the node being Connected proves nothing about the certificate.
- **The database logged nothing angry**: `docker compose logs db | grep -E
  "ERROR|FATAL"` should be silent on a clean first boot.

### 5. Close it up

1. Have them open the address and create the first account. It becomes the
   operator because its email is in `SUPERADMIN_EMAILS`.
2. **Then set `PUBLIC_SIGNUP_ENABLED=false`** and `docker compose up -d api`.
   Leaving it open on anything the internet can reach means anyone who finds
   the address can register. Do this in the same session, not as advice for
   later.
3. **Confirm out loud that they have stored `TENANT_CREDS_ENCRYPTION_KEY`**
   somewhere off the box. Ask them to tell you they have. Do not accept "I will
   later" as the end of the install.
4. Point them at https://docs.cobblr.xyz/getting-started for what to do with
   the empty workspace.

## When it does not work

Match the symptom before changing anything:

- **Browser says the connection is not secure, or `SSL_ERROR_INTERNAL_ERROR_ALERT`
  on tsnet** — no certificate was issued, almost always because
  `COBBLR_SITE_ADDRESS` is not a name that node owns. Compare it to the
  machine's full name in the Tailscale admin console, and check whether an
  older node already took the first part of the name.
- **The api never turns healthy** — read `docker compose logs api`. A boot that
  fails on a migration says so and stops on purpose rather than serving a
  half-migrated database.
- **The camera does not work on the phone** — check the page is on `https://`.
  This is a browser rule and there is no setting in Cobblr that changes it.
- **Anything else** — https://docs.cobblr.xyz/troubleshooting is organised by
  symptom, and its error-message table maps exact strings to causes.

## What not to do

- **Do not run `docker compose down -v`.** The `-v` removes volumes. On this
  stack the data lives in bind mounts under `./data`, but the habit is how
  someone else's database dies.
- **Do not edit a running instance's `.env` secrets** to fix a login problem.
  Changing `TENANT_CREDS_ENCRYPTION_KEY` on an instance that has workspaces
  makes their credentials undecryptable.
- **Do not install from a clone** unless they specifically want to build from
  source. The two-file image install is the supported path and the one the
  documentation describes.
