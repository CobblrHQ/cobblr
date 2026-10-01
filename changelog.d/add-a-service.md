---
type: feature
scope: connections
date: 2026-09-29
docs_target: docs/USER_GUIDE.md#4. The platform layer
---
Connect a service you installed yourself, such as a slicer, from Your account → Connections → Add a service: Cobblr reads what it offers from the service, tests your key, and says exactly what is wrong when something is.

## docs

### Adding a service

A service is something that does work for you and that you installed
yourself: a slicer, a design service. Connect it once from **Your account →
Connections → Add a service**.

1. **Where it is.** Its address, or, for a service on your own network, pick
   *On my network, through my bridge* and give its address there. The bridge
   reaches it; nothing on your network is opened to the outside.
2. **Read what it offers.** Cobblr reads the service's own description: its
   name, its version, and each job it can do, with what that job may do in the
   world (changes nothing elsewhere, changes things you own elsewhere, costs
   money, or acts in the world, which always asks first). If the description
   is broken, it says which part.
3. **Key.** Paste the one key the service's `mint-key` command showed you and
   press **Test**. A wrong key says so; a service that is down says that
   instead.
4. **Where it works.** Choose the workspaces it serves, as for any connection.

Some services are other companies' APIs that Cobblr speaks itself, such as a
print-failure detector. They are listed on the same Add a service form under
their own names, each asking only for what it needs (usually an address and a
key), with the same Test.

A Make that stops for want of a slicer links straight here, already asking
for a slicer.
