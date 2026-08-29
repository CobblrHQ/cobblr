# The Cobblr install skill

`SKILL.md` here teaches an AI coding assistant to install and verify a
self-hosted Cobblr instance. It is written for [Claude
Code](https://claude.com/claude-code), and the procedure inside is plain enough
that any assistant that can run shell commands can follow it.

## Use it

```bash
mkdir -p ~/.claude/skills/cobblr-selfhost
curl -fsSL https://docs.cobblr.xyz/self-host/SKILL.md \
  -o ~/.claude/skills/cobblr-selfhost/SKILL.md
```

Then ask for what you want in your own words: "install Cobblr on this box",
"my Cobblr instance stopped answering", "finish the install I started
yesterday". The skill loads itself when the request matches.

## What it does, and does not do

It asks **three** questions, because three are all that cannot be guessed: the
address, the operator email, and which HTTPS path you have available.
Everything else is defaulted, because the defaults are right and an install
that interrogates you feels like a configuration exercise.

It refuses to finish on two points. Public signup gets closed once your account
exists, and it will not sign off until you confirm you have stored
`TENANT_CREDS_ENCRYPTION_KEY` somewhere off the box. That value decrypts every
workspace's database credentials, and losing it destroys the data in a way no
backup fixes.

It also proves the install rather than assuming it: a healthy container that
serves nothing is a real outcome, so the skill checks the api answers, the app
itself loads, and on a Tailscale install that a certificate actually issued.

## Why it does not carry its own copy of the configuration

Every variable, service and profile it names is checked against
`deploy/selfhost/standalone/docker-compose.yml` and its `.env.example` by
`scripts/lint-selfhost-skill.ts` on every change to this repository. A
variable that stops existing fails that check in the same pull request that
renames it.

An assistant working from a stale copy does not hesitate. It writes a
plausible variable into somebody's `.env`, the stack ignores it, and the
install looks finished while behaving wrongly, with nothing anywhere reporting
the mismatch. So the skill takes its facts from the files it installs, and
tells the assistant to prefer the [setup builder](https://docs.cobblr.xyz/setup-builder)
over anything it remembers.
