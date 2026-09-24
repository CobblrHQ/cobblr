// Native-field presentation overrides, read side: the platform's one reader
// (platform-web field-presentation). A bundle or the workspace RELABELS and
// SHOWS/HIDES a kind's native fields (or an instance's, since an instance has
// its own kind id); forms use `label(name, default)` and skip `hidden(name)`,
// and an item's fields wait behind PresentationGate until `ready`.
export { useFieldPresentation, type FieldPresentation } from "@cobblr/platform-web";
