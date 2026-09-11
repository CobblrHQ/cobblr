---
type: fix
date: 2026-09-11
---
A failing assistant benchmark no longer holds back the nightly release. It used to fall back to the newest commit the benchmark had passed on, which left the nightly days behind while unrelated fixes waited on one regression. The benchmark still runs before the cut and its verdict is reported in the morning summary, so a regression can be fixed before it ships; continuous integration still has to be green.
