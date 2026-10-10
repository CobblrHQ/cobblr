---
type: internal
scope: ci
date: 2026-10-09
---
Every merge queue and merge-pr now land in one repository-wide mode; in train mode merge-pr hands a pull request to the train, except main's red fix and a pull request labelled merge-machinery, each recorded in the ledger.
