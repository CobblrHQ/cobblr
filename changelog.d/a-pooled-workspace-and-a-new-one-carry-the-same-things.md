---
type: internal
scope: platform
date: 2026-09-22
---
**A workspace born today carries what a workspace that existed at boot carries, checked every run.** CI hands a test either a pooled org (baked before the job, through every boot pass) or a fresh signup, by the accident of the test's position in the run, and a difference between the two failed one run in four. A parity test now takes one of each in the same run and diffs everything they carry (every org-keyed platform table, the tenant's columns, triggers, row counts and migrations), so a boot-only or signup-only grant fails every run with the difference named. The pool keeps two orgs back so the test always has one to compare. Its first run caught a real one: a pooled org's chosen modules carried no user claim, so a bundle uninstall could switch a module off where it stayed on for a fresh signup. The claim now lives in the enable chokepoint and every door passes it; a pool baked before this is healed at checkout.
