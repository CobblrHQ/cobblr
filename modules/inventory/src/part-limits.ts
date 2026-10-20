// How long an item's name may be: the create and edit schemas refuse past it
// and every name input stops there, so a person is never let type a name the
// save will refuse (#7592).
export const PART_NAME_MAX = 160;
