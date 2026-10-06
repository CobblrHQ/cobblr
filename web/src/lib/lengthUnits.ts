// Length entry/display for the floor plan. Geometry is ALWAYS stored in mm;
// users type whatever unit they think in and the UI echoes values back in the
// unit they used. The parser is the contract's, shared with the api and the
// assistant (packages/platform-contract/src/outer-size.ts).
// See docs/design-decisions/location-floor-plan.md (decision #1).

export { formatLength, MM_PER, parseLength, type LengthUnit } from "@cobblr/platform-contract/outer-size";
