# Security policy

Cobblr is a multi-tenant platform that people trust with their workshop and
household data. If you find a way to break that trust, we want to hear about it
privately first.

## Reporting a vulnerability

- **Preferred:** open a private report via GitHub Security Advisories on
  [CobblrHQ/cobblr](https://github.com/CobblrHQ/cobblr/security/advisories/new).
- **Email:** security@cobblr.xyz.

Please include the version you tested (the `version` and `build_sha` from
`/api/v1/healthz`, or Configuration → Health), steps to reproduce, and what an
attacker gains. You will get an acknowledgement within a few days.

Please do **not** open a public issue for a vulnerability, and do not test
against cobblr.me workspaces you do not own — stand up a self-host instance
(see [SELF_HOSTING.md](./SELF_HOSTING.md)); it is the same code.

## Scope

- The platform in this repository (api, web, modules, the self-host stack).
- The published container images (`ghcr.io/cobblrhq/cobblr-*`).

Out of scope: denial of service against the hosted service, social engineering,
and issues requiring a malicious workspace *owner* (owners are trusted within
their own tenant by design — tenant isolation between workspaces is very much
in scope).

## Supported versions

The newest stable release and the current nightly channel receive fixes.
Security fixes ship as a new release; there are no backports to older tags.
