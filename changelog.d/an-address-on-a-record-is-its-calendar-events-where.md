---
type: feature
scope: fields
date: 2026-10-11
docs_target: docs/USER_GUIDE.md#4.5 Custom fields
docs_published: 2026-10-12
---
Records can carry an address. The picker offers the places your workspace already used as you type, and the address becomes the calendar event's Where, with directions on your phone.

## docs

**Address fields.** Choose **address** as a field's type for where something
happens: a service appointment, a vet visit, a registration renewal at the
motor vehicle office. On the record the field shows the place's name over its
street address, with **Directions**, which opens Apple Maps on an iPhone or
iPad and a maps page anywhere else.

Type in the box and the picker offers the addresses your workspace already
used, matched on the place's name or its street ("mvc" finds MVC Lodi
Agency), each with the record it was last used on. Pick one to use it again,
spelled the same way. Nothing matching? **Use** what you typed, or choose
**Enter street, city and postal code** to fill in the parts, where your
browser's address autofill can fill them for you. What you type always saves.

When a record has a date field and an address field, its calendar event
carries the address: the calendar lists the month's events that happen
somewhere under **Where to be this month**, and the subscribed iCal feed
gives the address to your phone's calendar, which shows it and offers
directions. Cobb can find a place you used before (`find_addresses`) and
write it the same way. An address field cannot change to another type, or
from one, after it is made.
