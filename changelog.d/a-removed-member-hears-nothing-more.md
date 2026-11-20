---
type: security
scope: workspace
date: 2026-11-18
---
Removing someone from a workspace now cuts them off from its live updates straight away. Before, a page they still had open kept being told which records changed after they were removed (which ones, never what was in them), and a page opened in the minute after could start listening again. Their open pages, API tokens and the kitchen QR they printed already stopped working at removal; the live updates now stop too. The same holds when someone is made a guest: a guest sees what the portal shares, so their open pages stop hearing which records changed, and a guest can no longer start listening to the workspace's record changes at all.
