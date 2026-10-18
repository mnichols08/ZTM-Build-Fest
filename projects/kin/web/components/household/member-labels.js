// How Kin names household members (Kin keeps no member names): "You", or the
// member's kind and number, as Household access lists them. Shared by that
// list (membership.js) and chat authors (web/chat/chat-room.js), so one
// person has one label everywhere.
//
// `members` is the service's household list in its order
// (`/api/household`: { id, kind, active }). Adults and Limited members are
// numbered among the active ones of their kind; Temporary members among all
// of theirs (an ended one stays listed). The current member keeps their
// place in the numbering but is labelled "You".

export const MEMBER_KIND_LABELS = Object.freeze({ adult: "Adult", limited: "Limited member", temporary: "Temporary member" });

/** Map of member ID to label; members not listed (an Adult whose access
 * ended) are absent, and callers name them as they see fit. */
export function memberLabels(members, currentMemberId) {
  const labels = new Map();
  for (const kind of ["adult", "limited", "temporary"]) {
    const section = members.filter((member) => member.kind === kind && (kind === "temporary" || member.active));
    section.forEach((member, index) => {
      labels.set(member.id, member.id === currentMemberId ? "You" : `${MEMBER_KIND_LABELS[kind]} ${index + 1}`);
    });
  }
  return labels;
}
