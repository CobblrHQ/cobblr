---
type: feature
scope: integrations
date: 2026-09-28
docs_target: docs/USER_GUIDE.md#3.19½ Edge bridges (Configuration → Edge bridges)
---
**Install a bridge with one line and a code.** Setting up a bridge now gives you a short code and a single command to paste on the box: it installs the bridge as a service that starts at boot and keeps itself up to date, on Linux, macOS and Raspberry Pi, including 32-bit Pi OS and a Pi Zero. The bridge's key is made on that box and never passes through your clipboard. Docker is still there for people who want it.

## docs

**Installing a bridge with a code.** Under **Set up a bridge**, name it and press **Get an install code**. Cobblr shows a code like `K9GD-ZW4B` and one line to paste on the machine that will be the bridge:

```
curl -fsSL https://your-cobblr/api/v1/edge/install.sh | sh -s -- K9GD-ZW4B
```

The code works once, for fifteen minutes. The script trades it for the bridge's own key, which stays on that machine, fetches what it needs (Node, if the machine does not have a recent one, and the bridge from your Cobblr), and starts the bridge as a service that comes back after a reboot and updates itself. It runs on Linux (x64, arm64, 32-bit Raspberry Pi OS, a Pi Zero) and macOS. Add `--system` to install it for the whole machine rather than your user, or `--docker` to run it in Docker. The bridge shows up under the name you gave it within a minute; if the code has expired or was already used, the script says so and you make a new one. Prefer to manage containers yourself? The **Docker** tab still gives you a `docker run` or compose snippet with a key made for it.
