// Ask Cobb page context now lives in @cobblr/platform-web so module UIs (inventory,
// projects, …) can publish too, sharing ONE store instance with the core pages.
// Re-exported here so the existing `../lib/chat-context` imports stay stable.
export { usePublishChatContext, getChatPageContext, type ChatPageContext } from "@cobblr/platform-web";
