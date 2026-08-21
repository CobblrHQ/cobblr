---
type: feature
scope: ai
date: 2026-08-21
docs_target: docs/USER_GUIDE.md#3.22 AI providers & the AI kill-switch (operator)
---
**Your AI key is checked as you paste it, and the model becomes a dropdown.** Before, a key was only tested after saving, so a wrong one got written down and the connection sat there broken until you went back to edit it. Now the form checks what is currently typed and says so underneath, a moment after you stop: **Works**, or the reason it did not. Nothing wrong is stored. The same check asks the provider which models it serves, so the Model field turns into a list you pick from instead of a name you have to type exactly right. A provider's list is not curated: Google AI Studio reports 51 models and most of them make video, music or speech and cannot answer a prompt at all, so the chat ones are grouped at the top and the rest sit under them. Nothing is hidden. All three places you can add a key do this: adding a provider to a workspace, replacing its credentials, and your own connections under Your account.

## docs

When you paste an API key, Cobblr checks it right there, about half a second after you stop typing. Underneath the field you get either **Works** or the reason it failed (a wrong key usually reads `status 400`). Nothing is saved while this happens, so a key that does not work never becomes a broken connection you have to find and fix later.

That same check asks the provider what it can run, so the **Model** field changes from a text box into a dropdown of the models your key can actually reach. Leave it on **Use the default** unless you want a specific one. The default is the right pick for most people, and it is named on the field so you can see what you are getting.

Providers do not curate that list for us. A Google AI Studio key reports 51 models, and most of them generate video, music, speech or embeddings and cannot answer a prompt at all. So the dropdown puts the chat models under **Chat models** and everything else under **Everything else this key can reach**. The second group is not junk, it is the ones Cobblr could not identify from the name, and it is there precisely so a model it does not recognise is still selectable.

If the check cannot reach the provider at all, that is worth reading as a network answer rather than a key answer: a self-hosted model on your own machine has to be reachable from Cobblr, which for a hosted workspace means through your edge bridge.
