// Lives in platform-web so a module's own pages show the same "couldn't load"
// the app's pages do; this re-export keeps the app's imports where they were.
export { QueryError } from "@cobblr/platform-web";
