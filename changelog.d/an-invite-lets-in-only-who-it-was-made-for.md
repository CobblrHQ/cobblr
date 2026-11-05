---
type: security
scope: members
date: 2026-11-05
---
An invite now lets in only the person it was made for, and a single-use invite lets in one person. Before, anyone signed in who got hold of an invite link addressed to someone else could join with its role, so a forwarded admin invite made them an admin (since 2026.8.0); and several people pressing a single-use invite at the same moment could all get in (2026.11.0). Now an invite with an address admits only an account with that address, and anyone else is told it isn't theirs; a single-use invite admits exactly one; and a double press on a join link counts once. If you run your own Cobblr, update, then look over each workspace's member list for anyone you didn't invite, since people who already joined this way stay members. Someone invited at one address who signs in with another now needs that address, or a new invite made with no address.
