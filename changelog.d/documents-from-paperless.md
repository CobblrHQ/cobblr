---
type: feature
scope: core-documents
date: 2026-10-01
docs_target: docs/USER_GUIDE.md#3.4 Files (foundational)
docs_published: 2026-10-08
---
Your receipts, manuals and warranties in Paperless-ngx now show up on the things they belong to. Connect Paperless once under Your account → Connections → Add a service (directly, or through your bridge if it runs at home), and every record gets a panel with the documents that match it, already found by the time you open it. Link one with a tap and open it in Paperless from there; Cobb and assistants connected over MCP can find and link documents too.

## docs

### Documents from Paperless

If you keep receipts, manuals and warranties in Paperless-ngx, Cobblr can show
them on the things they belong to. Nothing is copied: Cobblr links to each
document where it is.

**Connect Paperless.** Your account → Connections → Add a service →
Paperless-ngx. Give its address and your API token (in Paperless: your
profile, API auth token). If Paperless runs on your home network and Cobblr
does not, choose **Through my bridge**.

**On every record.** Once Paperless is connected, every record has a panel,
**From your libraries**, with a **Documents** section. Cobblr matches your documents to your records in the
background, by name, serial number, model and barcode, so when you open the
dishwasher it already says "2 possible documents in Paperless". Press **Link**
to keep one, or **Not this one** to drop it. Linked documents show their
thumbnail, date and tags, with **Open** to see them in Paperless. **Find**
searches Paperless for anything else.

- Tick **also put a link back on the document** to have Cobblr write the
  record's address into a "Cobblr" field on the document in Paperless, so you
  can jump back.
- **Bring a copy into Cobblr** copies a linked document's file into the
  record's files, so it is in Cobblr's backup too.

**New documents within seconds.** Under **Get new documents here within
seconds** in the panel, press **Set it up** and add the workflow it describes
in Paperless (Trigger: Document Added, Action: Webhook). A receipt you scan is
then matched as soon as Paperless has it. Without the workflow, new documents
are found once a day.

**Whose documents.** If you connected Paperless just for yourself, what it
finds is shown to you alone. Shared with the workspace, it is shown to
everyone in it.

**Ask Cobb.** "What documents does the dishwasher have?" and "link the
warranty PDF to the dishwasher" work in Cobb and in assistants connected over
MCP.
