---
type: feature
scope: platform
date: 2026-10-03
docs_target: docs/USER_GUIDE.md#Money and currencies
docs_published: 2026-10-08
---
Prices kept their original currency, and totals converted them into your workspace currency at purchase-date rates.

## docs

Choose your main currency in General settings. A new workspace starts with the currency suggested by your locale. Existing prices without a saved currency read as the workspace currency, without changing their stored amounts.

Price fields have a currency picker beside the amount. Receipts carry their currency into purchase orders and lines. A saved price keeps its currency when you change the workspace currency.

Asset totals, purchase spend and the value of place contents use the exchange rate for the purchase date, or the entry date when no purchase date is recorded. Weekends and holidays use the preceding published rate. Hover over the conversion note to see the original amount, converted amount and rate date.

Rates come from the European Central Bank and refresh daily. If a currency or date has no available rate, the price stays out of the total and a note says how many items were excluded. The original price remains on the record.
