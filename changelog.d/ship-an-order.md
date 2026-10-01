---
type: feature
scope: sales
date: 2026-09-29
docs_target: docs/USER_GUIDE.md#3.26 Sales (outbound orders)
docs_published: 2026-10-01
---
Ship a sales order with its tracking number: the carrier is worked out from the number, the order shows where the parcel is and keeps a history of what happened to it, and the customer gets a shipping notice with the tracking link, emailed from your own address when you tick "Email the customer", or copied for you to send when your workspace has no email set up.

## docs

**Ship an order.** On a sales order, **Ship** asks for the tracking number (optional) and works out the carrier from it, with a link to follow the parcel. Before anything moves it shows the message your customer will read: the order number, the carrier, the tracking number and the link. **Copy** puts it on your clipboard to send yourself. When your workspace sends email (Configuration → Email) and the customer has an email address, an **Email the customer** box appears; tick it and press **Ship and email** to send the message from your own address. Nothing is ever emailed to a customer unless someone ticks that box and presses the button: shipping from a wire or the assistant never emails. An order that has not been fulfilled is fulfilled first, and one that is short of stock does not ship. Once shipped, the order shows the carrier and tracking number, a **Shipment** panel follows the parcel, and the order's **History** lists everything that happened to it: created, parts taken from stock, shipped, and each email with who sent it and when.

**Your workspace's email.** Configuration → **Email** is how your workspace emails people who are not members, such as a customer whose order has shipped. Pick a provider (SMTP, Mailgun, Resend or Postmark), enter the address to send from and its settings, then **Send me a test** to see one arrive. Passwords and keys are stored encrypted and never shown again. Every email the workspace sends is listed on the same page. Remove the settings and nothing is emailed to customers again.
