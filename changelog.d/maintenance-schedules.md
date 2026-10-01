---
type: feature
scope: maintenance
date: 2026-09-28
docs_target: docs/USER_GUIDE.md#3.16 Maintenance
docs_published: 2026-10-01
---
**Service schedules.** Tell a machine, a car or anything else you look after how often it wants servicing, either by the calendar ("every 3 months") or by use ("every 200 print hours" on a printer). Its next service is always on the log. Logging the service moves the schedule on from the day you did it, and anything due or overdue shows on Needs you, in your notifications and in Discord.

## docs

Open a machine, an asset or anything else you service, and find **Service schedule**. Type what needs doing ("Oil change"), then pick how often: **Service every [3] [months]**. If you know when it was last done, add the date and the first one is counted from there.

A printer (or anything that counts its use) also offers its counters in the same list: **Service every [200] [print hours]**. The list shows the current reading beside each one, so you can see where the count starts.

After that you don't need to do anything. The next service sits on the maintenance log with its date. When you do the work, log it the usual way (**Log service** on the record, **Done** on the Maintenance page, or the tick on Needs you) and the schedule moves on from that day and books the next one. Logged a service under the same name as a schedule? That counts too.

A usage schedule comes up once the counter passes its mark, and says by how much: *Nozzle change on Bench printer: overdue by 5 print hours*. Services due soon or overdue show on the dashboard's **Needs you**, and reach you as a notification and a Discord DM if you have those on.
