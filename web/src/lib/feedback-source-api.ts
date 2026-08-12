// This instance's own feedback queue, as a FeedbackSource.
//
// The adapter that keeps the triage UI free of a transport: the shared component asks
// this for items and hands it updates, and the ops hub supplies a different one backed
// by its cross-instance mirror. Neither host has to know about the other.
//
// `update` is present here because an instance owns its rows and may act on them. The
// hub's source omits it, which is what makes the component hide the controls rather
// than offer ones that would write to the wrong database.

import type { FeedbackSource, FeedbackSourceItem, FeedbackUpdate } from "@cobblr/platform-web";
import { api } from "./api";

export const apiFeedbackSource: FeedbackSource = {
  name: "this instance",
  async list({ status, sort } = {}) {
    const res = await api.listFeedback(status, sort);
    // The api's FeedbackItem and the seam's FeedbackSourceItem describe the same row;
    // the seam is the narrower of the two, so this is a widening, not a lie.
    return { items: res.items as unknown as FeedbackSourceItem[] };
  },
  update(item, body: FeedbackUpdate) {
    return api.updateFeedback(item.id, body);
  },
  imageUrl(item, fileId, variant) {
    return api.feedbackAttachmentRawUrl(item.id, fileId, variant);
  },
};
