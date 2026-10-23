// The platform contract — types and validators that modules import
// when registering with cobblr-core. Modules MUST NOT import from
// @cobblr/api directly; everything they need crosses through here.
//
// Phase 0 ships the stub: the typed manifest schema, defineModule(),
// and intent declaration shape. Module loading wires onto these in
// later phases.

// Scanned-label parsing lives in its own file, reachable at
// `@cobblr/platform-contract/qr-token`. It is deliberately NOT re-exported here:
// this package is consumed source-first, and the api loads it under plain Node,
// which resolves a relative specifier literally. `./qr-token.js` does not exist
// (only the .ts does), so a re-export here fails at runtime while tsc and tsx
// both resolve it happily. The subpath export sidesteps the question.

export { parseDecodeRole, type DecodeRole } from "@cobblr/platform-contract/decode-role";
export { groupListRows, normalizeGrouping } from "@cobblr/platform-contract/grouped-list";
export type { GroupBy, GroupPlan, GroupedResult, EntityGroup, GroupTotal } from "./grouped-list.js";
export type { Money, MoneyTotal, MoneyConversion, ExchangeRates } from "@cobblr/platform-contract/money";
export type { PlatformServices } from "@cobblr/platform-contract/services";
export type { DateFieldDirection } from "@cobblr/platform-contract/date-field-direction";
export { dateFieldDirection, directionOfRole, canBeOverdue, dateEventTitle } from "@cobblr/platform-contract/date-field-direction";
export { randomId } from "@cobblr/platform-contract/random-id";
export { pluralise, countOf, wordForCount, countWordsFor, quantityWithUnit, itemNounFor, articleFor, withArticle, type CountWords } from "@cobblr/platform-contract/plural";
export { PLATFORM_OWNER, PLATFORM_COMMANDS, PLATFORM_COMMANDS_VERSION } from "@cobblr/platform-contract/platform-commands";
export { expiryState, expiryPhrase, EXPIRING_WITHIN_DAYS, type ExpiryState, type ExpiryReading } from "@cobblr/platform-contract/expiry-grace";
export { fieldDay, fieldDayUnreadable } from "@cobblr/platform-contract/field-day";
export { arrivedEverywhere, dayHere, dayIn, countdownWords, daySaid, daysUntil, daysUntilField, theirDay, type Day } from "@cobblr/platform-contract/day";
export { keepMembers, isMember, parcelAudience } from "@cobblr/platform-contract/membership";
export { splitEntityKind, entityKindOf, type EntityKindParts } from "@cobblr/platform-contract/entity-kind";
export { actionRunsUnconfirmed, type ActionConsent } from "@cobblr/platform-contract/action-consent";
export { ActionRefusal, isActionRefusal, crashSentence, argumentRefusal } from "@cobblr/platform-contract/action-refusal";
export { isActionStep, type ActionUndoStep, type ActionUndoer, type ActionUndoContext } from "@cobblr/platform-contract/action-undo";
export { approvalDedupeKey, blockedSentence, type ApprovalRemedy, type ApprovalRemedyKind, type BlockedAction } from "@cobblr/platform-contract/blocked-action";
export { destinationLabel, normaliseTargetKind, type DestinationTable } from "@cobblr/platform-contract/destination-label";
export { NotificationBatcher, type ComposedBurst } from "@cobblr/platform-contract/notification-batcher";
export {
  isListedChoice,
  ROLE_CLARIFIES,
  FACE_LABELS,
  FACE_NAMES,
  FIELD_NOTE_SUFFIX,
  FIELD_ROLE_LABELS,
  FIELD_ROLE_VALUES,
  FIELD_TYPE_VALUES,
  NOT_RETYPEABLE_FIELD_TYPES,
  RETYPEABLE_FIELD_TYPES,
  UNIT_FIELD_TYPES,
  fieldNoteKey,
  fieldRoleOwnedMessage,
  fieldRoleOwner,
  fieldRoleTypeRefusal,
  fieldTypeTakesUnit,
  isFieldNoteKey,
  type FaceName,
  type FieldDefType,
  type FieldRole,
} from "@cobblr/platform-contract/field-vocabulary";
export { isPlatformSet, platform, setPlatform } from "@cobblr/platform-contract/platform-runtime";
export { isFloatingModel } from "@cobblr/platform-contract/ai-models";

// One file per surface: a new declaration goes in its surface's file, never here (lint:contract-index-only-re-exports).
export * from "@cobblr/platform-contract/entity-fields";
export * from "@cobblr/platform-contract/decode-fill";
export * from "@cobblr/platform-contract/traits";
export * from "@cobblr/platform-contract/kind-schema";
export * from "@cobblr/platform-contract/module-parts";
export * from "@cobblr/platform-contract/module-manifest";
export * from "@cobblr/platform-contract/activity-and-events";
export * from "@cobblr/platform-contract/tenancy";
export * from "@cobblr/platform-contract/entity-resolvers";
export * from "@cobblr/platform-contract/platform-entities";
export * from "@cobblr/platform-contract/module-actions";
export * from "@cobblr/platform-contract/wires-and-health";
export * from "@cobblr/platform-contract/calendar";
export * from "@cobblr/platform-contract/overdue-and-addresses";
export * from "@cobblr/platform-contract/notifications";
export * from "@cobblr/platform-contract/integrations";
export * from "@cobblr/platform-contract/ai";
export * from "@cobblr/platform-contract/edge";
export * from "@cobblr/platform-contract/connections";
export * from "@cobblr/platform-contract/queue-and-auth";
export * from "@cobblr/platform-contract/placement";
export * from "@cobblr/platform-contract/fields-tags-catalogs";
export * from "@cobblr/platform-contract/files";
export * from "@cobblr/platform-contract/sweeps";
export * from "@cobblr/platform-contract/platform-files";
export * from "@cobblr/platform-contract/instances";
export * from "@cobblr/platform-contract/overlay-seams";
export * from "@cobblr/platform-contract/http";
export * from "@cobblr/platform-contract/hosted-panels";
export * from "@cobblr/platform-contract/auth-email";
export * from "@cobblr/platform-contract/scan-and-shares";
export * from "@cobblr/platform-contract/platform-services";
export * from "@cobblr/platform-contract/platform";
export * from "@cobblr/platform-contract/devices";
export * from "@cobblr/platform-contract/units-and-nav";
export * from "@cobblr/platform-contract/upload-one";
export * from "@cobblr/platform-contract/json-reply";
export * from "@cobblr/platform-contract/roled-facts";
export * from "@cobblr/platform-contract/row-history";
export * from "@cobblr/platform-contract/text-search";
export * from "@cobblr/platform-contract/tidy";
