// Ask Cobb page context now lives in @cobblr/platform-web so module UIs (inventory,
// projects, …) can publish too, sharing ONE store instance with the core pages.
// Re-exported here so the existing `../lib/chat-context` imports stay stable.
export {
  usePublishChatContext,
  getChatPageContext,
  type ChatPageContext,
  type ChatSelection,
  getChatSelection,
  publishRowSelection,
  publishTextSelection,
  clearChatSelection,
  useChatSelection,
  usePublishRowSelection,
  usePublishSelectedRecords,
  useSelectionResolver,
  subscribeChatSelection,
  resolveSelectionText,
  type ResolvedSelection,
} from "@cobblr/platform-web";
