// How long an item's name may be: the create and edit schemas refuse past it
// and every name input stops there, so a person is never let type a name the
// save will refuse (#7592).
export const PART_NAME_MAX = 160;

// How long a part's warranty details may be: the schemas refuse past it and
// the field says it as the text nears it, keeping what was typed (#4115).
export const PART_WARRANTY_DETAILS_MAX = 2_000;
