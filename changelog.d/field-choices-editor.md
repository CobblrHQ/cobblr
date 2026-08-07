---
type: feature
scope: platform
date: 2026-07-14
docs_target: docs/USER_GUIDE.md#4.5 Custom fields
docs_published: 2026-08-07
---
**A custom field can now be a dropdown, and you can set the options when you make it.** Records have always been able to render a text field as a dropdown with a **+ add new** option, so anyone can pick from your list or add their own on the spot and have it stick. The catch was that there was no way to *set* that list unless you hand wrote a bundle manifest. Now there is: on the `/fields` page, a text field gets a **Choices** box where you type the options (Enter or comma to add, paste a comma separated list to add several at once). Leave it empty and you get a plain text box, exactly as before. You can also add, remove and reorder the options later by clicking the field, which is safe: values already saved on your records are kept either way, because the options are suggestions rather than a rulebook. The form also stops asking you to invent a snake_case key. Type the label you want, like **Acquired from**, and the key `acquired_from` fills itself in.

## docs

### Making a field a dropdown

A **text** field gets a **Choices** box. Type each option and press Enter (or a comma), or paste a comma separated list to add several at once. On the record, the field then renders as a dropdown of those options with a **+ add new** entry at the bottom, so anyone can add an option on the spot and it lands back in the list for next time.

Leave Choices empty and the field stays a plain text box.

You can change the options later by clicking the field on the `/fields` page. This is always safe: the value on each record is stored as ordinary text, so removing an option never erases anything, and a record holding a value you have since removed still shows it.

That is the point of the list. It is a set of suggestions to save typing, rather than a rule about what is allowed.

### Label and key

Type the **Label** you would actually say out loud, such as `Acquired from`. The **Key** (`acquired_from`) fills itself in. The key is what templates (`{{acquired_from}}`), the API and CSV headers use. You can override it while creating the field, but you rarely need to.
