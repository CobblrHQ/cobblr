// What a person is told when a workspace has no AI of its own (#9622). A
// newcomer's second card on Home said "This workspace's plan doesn't include
// AI ... connect a model of your own": "plan" and "model" are words for
// someone who has chosen either, and a new signup has chosen neither. One
// sentence, said the same on Home, the AI page, the scan inbox and a photo
// that could not be identified; lint:ui-jargon refuses the old words.

/** That there is no AI here, in plain words. No full stop: callers end it. */
export const NO_AI_HERE = "AI help isn't set up in this workspace";

/** Who can change that, and where: anyone can bring their own AI from their
 *  Account (the Connect your own button goes to /me/connections). */
export const NO_AI_REMEDY = "You can connect your own AI under Account";
