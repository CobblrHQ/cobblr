// The suggestion hooks live in platform-web so module-owned pages share them
// (#3818); the web app reads them from there.
export { usePhotoSuggestions, usePhotoSuggestionFor, suggestedSrcFor, pictureStateFor, PICTURE_STATE_TEXT, markShownBeside, useShownBeside } from "@cobblr/platform-web";
