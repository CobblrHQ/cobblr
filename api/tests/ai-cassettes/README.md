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

## Keep both transports covered

Not every provider does tool-calling. A subscription bridge behind an OpenAI
wire ignores the `tools` field, so the loop falls back to a JSON **move** the
model writes in its reply. Those are two different code paths and both ship:

| round shape | path it drives |
|---|---|
| `{"tool_calls": [...]}` | native tool-calling (a first-party API key) |
| `{"content": "{\"type\":\"action\", ...}"}` | the tool-less move (a bridge, a small local model) |
| `{"content": "plain English"}` | a plain answer — most of what a model says |

Every cassette here once used `tool_calls`, so the tool-less path had no
coverage at all, and three stacked defects shipped on it. `lint:ai-corpus-shape`
now fails if either transport, plain prose, or a failure scenario disappears
from the corpus.

To record from a real model: run an instance with `COBBLR_AI_REPLAY_RECORD=<dir>`
and a real provider, have the conversation, then copy the files here and set
`match`.
