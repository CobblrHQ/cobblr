// The rule for what a personal API token may reach lives in
// @cobblr/platform-contract/token-access, so the stdio MCP server can offer
// exactly the tools its token can run. requireAuth applies it here.
export {
  TOKEN_ACCESS,
  accessMessage,
  isTokenAccess,
  tokenAccessAllows,
  type TokenAccess,
  type TokenAccessVerdict,
} from "@cobblr/platform-contract/token-access";
