/// <reference types="vite/client" />
// Vite's ambient types — makes `import.meta.env` (DEV/PROD/MODE) typed. Vite
// replaces these at build time, so `import.meta.env.DEV` is a literal `false` in
// a production build and the branch it guards is eliminated.
