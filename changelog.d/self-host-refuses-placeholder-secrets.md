---
type: fix
scope: platform
date: 2026-08-25
---
**A self-host instance refuses to start in production with a placeholder secret.** The setup templates ship the session key, the credential-encryption key and the database password blank, and the server now stops with a clear message if it boots in production while any of them is still a template default or a known placeholder. Before, a copied template could quietly run with a publicly-known signing key. Generate real values (the setup builder and the openssl one-liners in the .env template do it for you) and the instance starts as normal.
