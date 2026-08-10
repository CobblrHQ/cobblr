# Cobblr

**Build the app nobody can sell you.** Cobblr is a self-hosted platform for
tracking the things you care about, when no off-the-shelf app fits the way you
actually work. You turn features on instead of writing code.

A skein of yarn, a brake caliper, a Lego set: every app that tracks them is
secretly the same app, a list of things with fields, units and photos. The only
real difference is the costume. Cobblr hands you the plain list and you dress it
yourself, so the niche app you cannot find stops being missing.

## What you get

**Modules** are the pieces you turn on: inventory, locations, QR labels,
scanning, machines, maintenance, projects, purchases, files, recurring
schedules, saved views, tags, notifications. Ignore the rest.

**Bundles** are 31 ready-made setups that install a whole shape in one click:
the right fields, units, and a saved view, pinned. Yarn, Home Inventory, Plants,
Pets, Vehicles, Filament, Lego, Medications, Warranties, and more. Install adds
only what the bundle brings, uninstall takes only that away, and anything you
customized on top stays yours.

**Wires** are the part a spreadsheet never had. A connection is a sentence you
click together: *when stock runs low, add it to the shopping list*. Milk runs
low so it lands on your list, you check it off and the count goes back up. A
print finishes and the filament it used comes off the shelf. No code.

Some things this adds up to:

- Scan a barcode and the make, model and photo fill themselves in. Print a QR
  sticker for every bin, scan it with your phone, see what is inside. Open
  databases cover groceries, books, and music out of the box; for the rest there
  is an optional shared network where you get everyone else's corrections and
  yours go back in.
- Run a workshop: the machines, the builds in flight, the parts they consume,
  and the service each one is due for.
- Keep a collection and share a read-only view of it, photos shown, prices
  hidden.
- Put the next oil change or warranty expiry on your calendar before it lapses.

Cobblr coordinates, it does not actuate. It decides *what* and *when*, keeps the
record, and sends the command to whatever already does the work, so your to-do
list can send a job to a printer and your plant collection can tell a home
automation controller to open a valve. The hardware keeps its own software.

If you connect your own AI key (Claude, OpenAI, or a local Ollama) you can also
describe what you track in a sentence and have the bundle built for you, then
approve the change before it lands. It is your key and your account, not a
quota. Nothing else on this list needs AI.

## Run it yourself

Your hardware, your data, no subscription. Cobblr runs as a set of Docker
containers on a Linux box, a Mac, a NAS, a Raspberry Pi (4/5, 64-bit), or an old
laptop.

Start at the **[setup builder](https://docs.cobblr.xyz/setup-builder)**. It asks
a few questions, generates every secret for you, and hands you a
`docker-compose.yml` and a `.env`. Put both in a folder and:

```bash
docker compose up -d
```

That is the install. Updating is `docker compose pull && docker compose up -d`,
across PostgreSQL major versions included. The images are multi-arch, so a
Raspberry Pi runs the same file as a server. The
[install guide](https://docs.cobblr.xyz/self-hosting/install) walks it through
end to end.

If you would rather build the images yourself than pull them,
[SELF_HOSTING.md](SELF_HOSTING.md) has that path too.

Either way you get the full multi-tenant server, not a cut-down single-user
build: one box, many accounts, each workspace with its own database, and an
operator console at `/admin` above all of them.

**The camera needs HTTPS.** Browsers only allow it over HTTPS or on `localhost`,
so scanning barcodes from your phone means giving the box a real hostname.
[SELF_HOSTING.md](SELF_HOSTING.md) covers free ways to get one with DuckDNS,
Cloudflare, or Tailscale, none of which open a port. You can add HTTPS later in a
two-line edit, so it is not a decision you have to get right up front.

Releases come on two channels. `nightly` carries what landed the day before.
`2026.8.0` is the first numbered release.

## Where things are

| | |
|---|---|
| `api/` | Express + Kysely backend, and the wasm sandbox that runs third-party modules |
| `web/` | React + Vite frontend, installable as a PWA |
| `modules/` | The first-party modules |
| `bundles/` | The 31 ready-made setups |
| `packages/` | The contract modules build against, shared UI, and the sandbox SDK |
| `deploy/selfhost/` | Compose overlays, TLS proxy configs, and the standalone image stack |

## Docs and community

- [Documentation](https://docs.cobblr.xyz), including the
  [install guide](https://docs.cobblr.xyz/self-hosting/install)
- [cobblr.xyz](https://cobblr.xyz/) for what it is and what people build with it
- [Community forum](https://cobblr.discourse.group) for questions and what you made
- [Status](https://status.cobblr.xyz)
- Security reports: [SECURITY.md](SECURITY.md)

## License

Cobblr is source-available under the Functional Source License
([FSL-1.1-ALv2](LICENSE.md)). You can read it, run it, change it, and build on
it for any purpose except making a competing product. Two years after each
release, that version becomes Apache 2.0. See [LICENSE.md](LICENSE.md) for the
exact terms.
