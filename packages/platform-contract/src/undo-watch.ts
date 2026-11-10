// Which records an Undo step names, by the shape of its args: the rule the
// kernel's judge watches History by (api/src/platform/issued-undos.ts) and
// lint:every-undo-is-judged reads a step's source by. One rule, so the lint
// can never credit a step the judge does not watch (#9419).

/** An arg key that hands a step a record by id: `id`, `ids`, `part_id`,
 *  `build_ids`, `partId`, `itemIds`. */
export const NAMES_A_RECORD = /^(id|ids|.+_ids?|.+Ids?)$/;
