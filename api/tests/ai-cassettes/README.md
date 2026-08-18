# AI cassettes

Recorded model behaviour for tests. `COBBLR_AI_REPLAY_DIR` points the api at
this directory (CI does), which registers the `replay` provider. It is
**opt-in per workspace**: a test installs it (`POST /modules/core-ai/providers`
with `provider_id: "replay"`), and from then on every chat turn in that
workspace replays a cassette instead of calling a model. Tests that never
install it keep the no-provider world they were written for. No network, no
key, no cost, deterministic.

The loop, the tool registry, the persisted turn and the widget contract all run
for real. Only the model's answer is canned, and it is canned per ROUND, so a
cassette can make the loop call a tool and then answer from the result.

One file per scenario:

```json
{
  "match": "how many racks",
  "rounds": [
    { "tool_calls": [{ "name": "list_records", "args": { "kind": "core-locations:location" } }] },
    { "content": "You have {n} racks under Den." }
  ]
}
```

`match` is a substring of the last user message. `rounds[N]` is what the
model says on the Nth call of that turn. `"match": "*"` is the fallback for
anything a test does not care to script.

To record from a real model: run an instance with `COBBLR_AI_REPLAY_RECORD=<dir>`
and a real provider, have the conversation, then copy the files here and set
`match`.
