---
type: feature
scope: purchases
date: 2026-09-28
docs_target: docs/USER_GUIDE.md#4.5 Custom fields
---
**A thing knows what it cost from its order.** A line on a Purchases order can now say it bought anything, a printer, an asset or a part, and the thing gets its Acquired from, Acquired on and Paid from the order with a **from order** link under each, while the thing and the order link to each other. A printer filed from a receipt is linked the same way. Change the order's vendor or date and the thing follows, unless you changed the field yourself: what you type is never written over.

## docs

**An order fills a thing's provenance.** A Purchases order line can say what it
bought, any record, not only a part. The thing then gets *Acquired from* (the
vendor), *Acquired on* (the order date) and *Paid* (what one cost), each with a
**from order** link, and the thing and the order link to each other. The thing's
own fields are the answer everywhere; an order edit reaches them only where you
have not typed your own value.
