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

A round may point INTO an earlier tool result, because a recorded model that
searched and then acted carries the id of a record that exists only where it
was recorded: `"entity_id": "$prev.data.items[0].id"` reads the first hit of
the previous tool result when the round is played, and
`"$result.list_records.data.items[0].id"` reads the most recent result of
THAT tool whatever came after it (a bounced write leaves its own result on
top). `two-cubepros-one-label.json` is the shape: search, take the first hit,
act, which is what the live model did (#3154). The longest matching `match`
wins, so a cassette for the re-ask "label on the cubepro #9" beats the one
for the sentence it extends.

`"refuse": "quota"` (or `invalid_key`, `model_unavailable`, `unreachable`,
`unknown`) makes the provider REFUSE the turn instead of answering: the same
`ProviderError` a real adapter throws on a 429 or a rejected key, with the
reason's sentence, so a test drives the refusal path with no key and no
network (`refuses-the-plan.json`: a computed plan must survive it).

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

## Image cassettes (the scan surfaces)

A photo has no "last user message" to match, so the image capabilities
(`identify-image`, `classify-image`, `extract-text`) replay by a PERCEPTUAL
hash of the picture (an 8x8 average hash, 16 hex chars), one canned reply text
per cassette, in the `images/` subdirectory (the corpus lint holds every file
in THIS directory to the rounds shape above):

```json
{
  "image_ahash": "c3030c3c3dffffff",
  "capability": "identify-image",
  "reply": "{\"name\":\"Hardware store receipt\",\"observations\":\"A printed receipt…\",\"category\":\"receipt\"}"
}
```

Perceptual, not a byte hash, because the identify step sends the file store's
resized "medium" JPEG rather than the bytes a test uploaded; a resize or a
re-encode moves a bit or two, and a match allows a few. `capability` is
optional (omitted = any image capability). The key for a fixture:

```
npx tsx scripts/image-cassette-key.mjs e2e/fixtures/bench-vision/receipt.png
```

The files under `images/` script the intake's receipt verdict: `receipt.png`
identifies as a receipt and reads into three lines, `two-things.png`
identifies as a product, `label.png` identifies as a label (a receipt the
identify step missed) and reads into two lines when a person says "Read as a
receipt". An image with no cassette gets the stable fake
`{"name":"replayed item","confidence":0.5}`, as before.

Two things changed on 2026-09-13 (#2916). A receipt-shaped image never
reaches the identify cassette on a machine with the OCR engine: the shape
check routes it first, and the receipt door's own line tier then reads a
clean render with no model at all, so `receipt.png` reads into its lines
without touching `receipt-lines.json` there. A test of a read that FAILS
uploads `receipt-torn.png` instead: its three visible lines do not add up
to the printed subtotal (a line is torn off), so the line tier declines and
the read needs the model, which `receipt-torn-lines.json` answers for. The
review pack's receipt identify cassettes (`review-pack-*-identify.json`)
carry the model's `is_receipt` field; `review-pack-yarn-and-lamp-identify.json`
deliberately scripts the wrong answer (the yarn, `is_receipt: "no"`) so the
consequence test can show the shape check overruling the model.
