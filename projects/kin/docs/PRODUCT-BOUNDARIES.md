# Product Boundaries for the October Plan Through v0.40

These boundaries apply to the October daily targets and guide the undated v0.41–v0.45 follow-up proposals.

## Tired-parent test

Every feature should answer:

> Would a tired household member actually use this to remember, coordinate, hand off, or recover context?

## Prefer

- fast capture;
- areas and reference context;
- routines;
- shopping/replenishment;
- short notes;
- explicit responsibility without scoring;
- offline/local-first behavior;
- encrypted portability;
- understandable recovery/deletion;
- small-household membership;
- accessible installed-web UX.

## Avoid

- AI interpretation or recommendations;
- points, streaks, scores, rankings;
- hidden read receipts, location, presence, activity monitoring (push notifications record nothing about delivery or reading, and are coalesced so they stay calm: [PUSH](PUSH.md)). Household chat's read receipts, typing indicators and "online now" are allowed only because they are visible, switchable by each member, reciprocal and never kept as history; there is no "last seen" ([ADR 0008](decisions/0008-household-chat.md));
- a general messenger: chat is one room for one household's members, with nobody outside the household, no public rooms and no anonymous sharing;
- generic project-management/workflow systems;
- public social features;
- architecture added mainly because it is technically interesting.
