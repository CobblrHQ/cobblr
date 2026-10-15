// The prose rules live in @cobblr/repo-guards (#6598), so every repository reads one copy. This path stays
// for the scripts, and the docs site's lint, that import it.
export { PROSE_RULES, lintProse } from "../packages/repo-guards/src/prose.mjs";
