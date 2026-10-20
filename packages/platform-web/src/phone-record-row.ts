// How tall a phone list row may be (PhoneRecordList): a name of up to four
// lines (Safari sets a long name wider than Chrome, and three cut "Custom
// CoreXY with the enclosed chamber and dual extruder" short), its line under
// it, and its padding. Every walk spec that bounds the shared row reads this
// one number (a-phone-row-is-bounded-the-same-in-every-spec.test.ts): the
// bound went from 96 to 112 px for the machines list, the assets and
// purchases list kept 96, and its four-line Weller row failed every night
// (#7621).
export const PHONE_RECORD_NAME_LINES = 4;
export const PHONE_RECORD_ROW_MAX_PX = 112;
