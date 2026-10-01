// The scan inbox's paste: anywhere on the page, or into the box at the top.
//
// A paste is read files first (usePasteImage): a picture goes to the photo
// pipeline and a PDF or CSV to the receipt reader, routed by type exactly as
// the upload button routes them (the same SCAN_PICKER_ACCEPT), and only text
// with no file is offered to `onText` (a product shared with its link). A
// PDF copied in Finder arrives as the file AND its name; the name used to be
// what landed, typed into the search box (#4523).
import { usePasteImage } from "@cobblr/platform-web";
import { SCAN_PICKER_ACCEPT } from "../components/ScanPhotoPicker";

export function useInboxPaste(takeFiles: (files: File[]) => void, onText: (text: string) => boolean): void {
  usePasteImage(() => document.body, {
    onFiles: takeFiles,
    accept: SCAN_PICKER_ACCEPT,
    multiple: true,
    onText,
  });
}
