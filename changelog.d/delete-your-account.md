---
type: feature
scope: core
date: 2026-09-22
docs_target: docs/USER_GUIDE.md#Deleting your account
docs_published: 2026-09-23
---
You can delete your account: **Your account → Identity & password → Delete my account**, confirmed with your password. If you are the only owner of a workspace you are told which one first, before any password is asked, and you can delete it or hand it over; workspaces you share stay with their other owners. An operator can remove an account from **Super admin → Users**, and a person with no workspace now lands on a page with doors (make one, sign out, delete the account) instead of a dead line.

## docs

**Delete my account.** Under **Your account → Identity & password**, the
**Delete account** box ends your account: every device is signed out, your
memberships, tokens and personal connections are removed, and nothing of yours
is kept. It cannot be undone.

Two things can stop it, and the page tells you which before it asks for your
password:

- **You are the only owner of a workspace.** The page names each one. Delete
  it (its settings page), or make somebody else an owner, then come back. A
  workspace you share is never deleted with you; it stays with its other
  owners.
- **Your account is managed by your Cobblr account** (you sign in through the
  central account service and have no password here). It is deleted there, and
  removing it there removes it from every Cobblr you signed into with it. If
  you cannot find that option yet, ask whoever runs the instance to remove your
  account for you.

Otherwise, type your password and confirm.

**No workspace?** If you deleted your only workspace, or nobody has added you
to one yet, signing in lands on a page that says so, with three doors: **Make
a workspace**, **Sign out**, and **Delete my account**.

**For operators.** **Super admin → Users** has a **delete** on each row. The
first question removes the account; if the person solely owns any workspaces,
a second question asks whether those go too (that drops their databases). A
platform admin cannot be deleted there, and neither can your own account.
