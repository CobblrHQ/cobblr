---
type: feature
scope: scan
date: 2026-06-19
---
Receipts now parse **without AI** whenever they can. Upload a **CSV** export or a **text PDF with a line-item table** and Cobblr pulls out the items deterministically: header-mapped columns for CSV, table extraction for PDFs, no model call, works even with no AI provider configured. A messy PDF falls back to a single AI text read, and a **photo** of a receipt still uses an AI vision read. Same one-row-per-line-item inbox triage either way; the inbox remembers how each line was read.
