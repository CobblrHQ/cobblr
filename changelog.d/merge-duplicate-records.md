---
type: feature
scope: scan
date: 2026-09-04
docs_target: docs/USER_GUIDE.md#3.20 Scan inbox (`core-scan`, stock)
---
Records that are the same thing under two names can now be put back together.
Open "Same thing twice" from the scan menu to see the pairs, keep the one you
want, and the other is added to it: the quantities are combined and anything the
kept record is missing is taken from the other.

## docs

Sometimes one thing ends up as two rows. A shop parsed on Monday calls it
"Roma Tomatoes" and one parsed on Friday calls it "Tomatoes Roma", and unless
you happen to read both lines side by side there is nothing to notice.

New scans no longer add to the pile: a scan that matches something you already
have is counted onto it instead of filed again. For the pairs already sitting in
your tables, open the scan page menu and choose **Same thing twice**.

Each pair shows both records with what they say about themselves, how many are
on hand and where they live, along with the words the two share so you can see
why they were put together. Press **Keep this one** on the record you want to
survive.

What happens then:

- the quantities are added together, because two rows of one apple are two
  apples;
- anything the kept record is missing is taken from the other one, and anything
  it already says is left alone;
- a date takes the earlier of the two, because the stock now in one row goes off
  when its oldest member does;
- the other record is removed.

The kept record keeps its own id, its links and its history, which is why the
choice is yours rather than automatic. If a merge cannot finish for any reason,
nothing is changed at all.
