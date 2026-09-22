---
type: fix
scope: assistant
date: 2026-09-22
---
"The Rostock Max ran four hours yesterday" now records the hours on that machine: the usage action took the machine only as an argument and ignored the record it was run on, so the assistant's correct call was refused as "no machineId". And "put purchase date and supplier under Buying on parts" groups the fields: the door read a list of fields as one string, so a list sent as a list read as nothing and was refused as "required". Both were held out of the assistant's nightly benchmark as model failures for a week; their transcripts showed the doors were wrong, not the model.
