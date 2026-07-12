---
type: fix
scope: platform
date: 2026-07-12
---
**Editing an AI connection now shows its saved settings.** The edit form used to blank every non-secret field on open, so a dropdown (like "How this AI runs tools") snapped back to its default and looked like it wouldn't save. Now the form pre-fills what's actually stored (base URL, dropdown choices, model), and saving merges your changes instead of replacing everything, so leaving a secret key blank keeps it. Secrets are still never shown.
