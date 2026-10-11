// Start counting before any api code runs (#5761 A1): `node --import ./dist/platform/test-attribution-preload.js
// dist/index.js`, only on the attribution run. The api loads its modules (each manifest's defineModule) before it
// builds the app, so counting begun in createApp missed all of it, and a change there read as code no test runs.
import { startTestAttribution } from "./test-attribution.js";

if (process.env.COBBLR_TEST_ATTRIBUTION === "1") await startTestAttribution();
