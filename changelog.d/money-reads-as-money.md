---
type: feature
scope: fields
date: 2026-10-02
docs_target: none (documented directly in USER_GUIDE.md, section 4.5 Custom fields, and docs/architecture/money.md)
---
Money reads as money everywhere. An asset's Paid typed as 4300 shows as $4,300, not a bare 4300, and it shows the same way in lists, exports, the assistant's answers and notifications. Every price and cost field takes 4300, 4,300 or $4,300.00 alike, and there is a new money field type for your own fields.

## docs

Pick **money** as a field's type on Fields & forms for a price, a cost or a value. It shows as "$4,300" on the record, in lists and in what the assistant says, and exports as "4300.00". Type it as 4300, 4,300 or $4,300.00; something that is not an amount is not saved. Built-in money fields (an asset's Paid, a part's Cost, order and sale prices, service costs) work the same way.
