---
type: fix
scope: core-scan
date: 2026-10-02
---
**A sale form is kept whatever the AI calls it.** When the AI read a dealer's sale form correctly but called it an invoice, the whole read was thrown away. An invoice, a bill of sale, a receipt, an order, a retail order and a purchase agreement are now read as the same thing: the record of a sale. A page the AI names as something else, such as a manual, is no longer taken for a sale.
