---
type: improvement
scope: edge
date: 2026-09-29
---
A bridge keeps printer status on time when it is also carrying slower calls, such as a local AI or another service on your network: slow calls get their own share of the bridge and can no longer crowd out your printers. A call through a bridge now keeps its method and the service's response details, and a service that stops answering is cut off at its deadline instead of holding the bridge open.
