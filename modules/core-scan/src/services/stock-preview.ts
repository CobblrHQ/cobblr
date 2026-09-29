// A stock agency's watermarked preview is never a picture we use (#3804). The
// rule lives in the contract so every door that takes in a picture asks the
// same question: see @cobblr/platform-contract/stock-preview.
export { isStockPreviewUrl, isStockPreviewResult } from "@cobblr/platform-contract/stock-preview";
