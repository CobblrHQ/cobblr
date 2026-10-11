---
type: feature
scope: inventory
date: 2026-10-11
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
---
The batch numbers printed on a spool's box are kept on its record, counted per batch, even though a spool has no use-by date.

## docs

**Batches without a date.** A filament box prints a batch number and no use-by. Filing it from the inbox keeps the batch on the record as a lot of its own, and a carton of ten whose boxes said B32051101 three times and B31060501 twice is one record of ten with **Show 3 lots**: 3 of lot B32051101, 2 of lot B31060501 and 5 whose batch nobody read, shown as **batch unknown**. The lots always add up to what is on the shelf. Before, a lot number entered without a date was forgotten the next time the record was read. The label reader also takes "Batch No." on a box as its lot, the way it takes "Lot" on a skein.
