---
type: feature
scope: vault
date: 2026-10-11
docs_target: docs/USER_GUIDE.md#The Vault
docs_published: 2026-10-12
---
A Vault for personal documents: folders whose documents are encrypted and opened only by the people you choose, never by search, Cobb, shares or anyone else in the workspace, its admins included.

## docs

The Vault keeps personal documents (a registration renewal, a passport scan, a tax letter) in your workspace where only the people you choose can open them. Find it under **Your account → Your Vault**, or go to `/vault`.

- **Folders and who can open them.** Make a folder and it opens only for you. On the folder's page, under **Who can open this folder**, tick the people in the workspace who may open it too. Nobody else can see the folder, its documents or how many there are, and that includes the workspace's admins. Only the folder's owner changes the list.
- **Documents.** **Add a document** to put a file in a folder. It is encrypted before it is stored. **Open** shows it in a new tab and **Download** saves it. Use **Move to…** to move it to another of your folders (you need to be able to open both). The folder's owner, or whoever added a document, can remove it.
- **History.** Every open, download, move and change of who can open the folder is listed under **History** on the folder's page, for its owner.
- **What never sees it.** Vault documents are not in search, shares, sends, spreadsheet exports, public pages or the scan inbox, and Cobb can never read one. Cobb can file a document you give it into one of your own folders ("put this registration in my Vault"); the plain copy is then removed from Files.
- **Backups.** A workspace backup carries Vault documents still encrypted, and restoring it brings back the folders, their documents and who can open them (anyone not in the workspace you restore into is left off).
- **API.** An API token reaches the Vault only when it was made with the **Vault** scope, and then only the folders whose list names you.
