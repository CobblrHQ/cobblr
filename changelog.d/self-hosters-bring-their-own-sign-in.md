---
type: selfhost
scope: account
date: 2026-10-05
---
Self-hosters can sign people in through their own OpenID Connect provider (Authentik, Authelia, Keycloak, Pocket ID): Operator console, then Sign-in, or COBBLR_OIDC_ISSUER, COBBLR_OIDC_CLIENT_ID and COBBLR_OIDC_CLIENT_SECRET for a first boot. The flow uses PKCE, state and nonce and checks the issuer and audience; a provider account links to an existing one only by a person signed in, never by a matching email; new accounts stay off unless you allow them, optionally per group; groups can map to workspace roles. Password sign-in can be turned off once a platform admin has signed in through the provider, and node dist/cli/password-sign-in.js on turns it back on. The guide, with setups for each provider, is docs/operations/sign-in-with-your-own-provider.md.
