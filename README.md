# Cobblr

Cobblr lets you build your own little apps to keep track of the things you care
about, without writing code. You turn features on instead of building them.

Some things people track with it:

- Parts and inventory, with stock levels and low-stock reminders
- Projects and to-dos
- Machines and the work you do on them
- Collections of almost anything

You start from a blank workspace, turn on the pieces you want (a table here, a
scanner there, a dashboard), and you have a small app shaped around how you
actually work. If you outgrow the built-in pieces, you can add your own.

## Run it yourself

Cobblr is self-hostable. It runs as a set of Docker containers on any machine
with Docker installed (a Linux box, a Mac, a NAS, a Raspberry Pi, an old
laptop). The outline is:

```bash
git clone https://github.com/CobblrHQ/cobblr.git cobblr && cd cobblr
cp deploy/selfhost/.env.example .env      # then fill in the values it asks for
docker compose -f docker-compose.yml -f deploy/selfhost/docker-compose.selfhost.yml up -d --build
```

The camera-based scanner needs HTTPS, so most setups want a real hostname. The
full walkthrough, including free ways to get one with DuckDNS, Cloudflare, or
Tailscale, is in [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md). Start there.

## License

Cobblr is source-available under the Functional Source License
([FSL-1.1-MIT](LICENSE.md)). In short: you can read it, run it, change it, and
build on it for any purpose except making a competing product. Two years after
each release, that version becomes plain MIT. See [LICENSE.md](LICENSE.md) for
the exact terms.
