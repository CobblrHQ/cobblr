// The wall-clock budget helper lives in the platform contract
// (packages/platform-contract/src/test-budget.mjs) so a module's own tests can
// wear their timeouts with only the module and the contract present (#6572).
// Every repo caller keeps this path.
export * from "../../packages/platform-contract/src/test-budget.mjs";
