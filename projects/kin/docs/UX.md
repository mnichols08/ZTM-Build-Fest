# Kin UX

> **Status:** Draft for `v0.14.x` UX/UI consolidation  
> **Directional horizon:** `v0.45.x` Build Fest release candidate  
> **Audience:** anyone designing, building, reviewing, or testing Kin's interface  
> **Related docs:** `ROADMAP.md` · `ARCHITECTURE.md` · `ACCESSIBILITY.md` · `PRIVACY.md` · `TESTING.md` · current version planning contracts

This document defines how Kin should **feel, behave, communicate state, and grow**.

It is both:

1. the UX contract for the product that exists now; and
2. a directional design system that allows Kin to grow toward the planned `0.45.x` feature set without repeatedly redesigning the app shell.

The visual direction is warm, calm, compact, household-oriented, and deliberately unlike workplace project-management software.

The product should feel like something that belongs in a kitchen, hallway, couch, grocery aisle, or tired parent's hand—not a sprint board.

---

# 0. How to read this document

UX decisions have one of four statuses.

| Status | Meaning |
|---|---|
| **Current** | Reflects an existing product capability or established behavioral contract. |
| **Adopted** | A design decision for `0.14.x` and later. New UI should follow it. |
| **Directional** | Intended destination for later `0.x` releases, especially toward `0.45.x`. Do not implement merely because it appears here. |
| **Open** | A meaningful decision still requires evaluation. |

A visual prototype may show **Directional** functionality that has not shipped.

Never treat prototype data, controls, navigation destinations, or copy as evidence that a capability exists.

Version planning contracts and implementation remain authoritative for shipped capabilities.

---

# 1. Product purpose

Kin helps a household **remember, coordinate, hand off, and recover context without requiring everyone to become a project manager**.

The primary product experience is not "task management."

It is:

> **What matters now, what changed, and what do we need from each other?**

Kin should reduce household mental load.

It should not create a new administrative burden.

## 1.1 Product characteristics

### Current

Kin's architecture now includes concepts such as:

- household membership;
- passkey-backed identity;
- trusted devices;
- pairing;
- encrypted synchronization;
- offline/local state;
- backup and restore;
- deletion lifecycle;
- recovery and household continuity.

The interface must represent these honestly without forcing users to understand their implementation.

### Adopted

Kin should remain:

- local-first;
- private by design;
- usable offline where practical;
- accessible;
- calm;
- understandable without technical knowledge;
- useful for simple household coordination before advanced organization is configured.

### Directional

The same shell should eventually accommodate:

- areas;
- household notes;
- richer routines;
- shopping and replenishment;
- planning dates;
- household modes;
- useful history;
- search;
- playbooks;
- reminders;
- reference records;
- maintenance;
- encrypted attachments;
- explicit responsibility;
- broader household membership;
- backup/restore and migration.

Those additions must not turn the primary interface into a dashboard of modules.

---

# 2. Who we design for

Kin users may behave very differently even inside the same household.

| Archetype | Wants | Quits when |
|---|---|---|
| **The doer** | "What needs doing right now?" | Setup and organization become homework. |
| **The planner** | Confidence that important things are captured | Others stop using the system. |
| **The quick capturer** | Somewhere to put a thought immediately | Capture requires categorization. |
| **The returning partner** | "What changed while I was gone?" | Changes are hidden in activity logs. |
| **The tired household member** | One obvious next action | Screens require reading and decision-making. |
| **The cautious user** | Confidence about privacy, devices, recovery, and deletion | Security behavior feels magical or vague. |

## Adopted principle

> **Design for the doer; serve the planner.**

If the least enthusiastic household member cannot use Kin in seconds, Kin becomes another responsibility assigned to the planner.

---

# 3. Core UX principles

## 3.1 The ten-second loop — Adopted

The core habit is:

```text
open
  ↓
see what matters / what changed
  ↓
add, claim, acknowledge, or complete one thing
  ↓
leave
```

The ordinary daily interaction should take roughly ten seconds and work one-handed.

Adding something should normally require:

- one field;
- one submit action.

Organization happens afterward.

---

## 3.2 Calm, never nagging — Adopted

No:

- streaks;
- guilt;
- "you're behind";
- red notification-count pressure;
- achievement systems;
- productivity scores;
- artificial urgency.

Unfinished household work is normal.

Use:

> "3 things still open."

Not:

> "You have 3 overdue tasks!"

---

## 3.3 Never a scoreboard — Adopted

Kin must not provide ammunition for household resentment.

Do not introduce:

- leaderboards;
- contribution percentages;
- per-person grades;
- completion rankings;
- "Sam did 72% of chores";
- productivity comparisons.

Attribution may be useful:

> "Sam finished Take bins out."

Evaluation is not:

> "Sam completed more this week."

If load is shown, it must be factual, calm, optional, and framed as household context rather than performance.

---

## 3.4 Honest about state — Adopted

At any moment, the user should be able to answer:

- Is this saved?
- Is it only on this device?
- Has it synced?
- Am I offline?
- Is this device still trusted?
- Did something change?
- Do I need to take action?

Security and sync state should use human meaning rather than architecture vocabulary.

Prefer:

> Up to date

> Waiting to sync

> Offline — changes are safe here

> This device is no longer trusted

> Recovery needed

Avoid exposing:

> epoch mismatch

> cursor failure

> provisioning grant expired

unless shown in diagnostic/admin details.

---

## 3.5 Never silently lose household context — Adopted

Errors should follow:

> **what happened → what is safe → what to do next**

Example:

> Couldn't save to this browser. What you typed is still here. Try again.

Destructive actions must either:

- be reversible;
- have an explicit recovery window;
- or clearly explain that they are irreversible.

---

## 3.6 Private by design, visibly — Adopted

Privacy cannot exist only in documentation.

Kin should periodically and appropriately communicate:

- household content is encrypted where that guarantee actually applies;
- trusted devices share household data;
- the service may coordinate sync without understanding household content;
- some metadata may still exist;
- recovery has limits.

Never claim:

> "The service knows nothing."

unless that is literally true.

Prefer specific claims.

---

## 3.7 Familiar over clever — Adopted

Prefer:

- lists;
- check controls;
- plain buttons;
- bottom navigation;
- forms;
- cards;
- familiar disclosure patterns.

Avoid gesture-only interfaces and experimental navigation.

Kin's novelty should come from **how little effort household coordination requires**, not unusual controls.

---

## 3.8 Optional complexity stays out of the daily loop — Adopted

Advanced features should live behind context, search, or `More`.

The Today screen should not gradually accumulate:

```text
tasks
shopping
maintenance
notes
devices
backup
recovery
history
settings
attachments
members
```

all at once.

Advanced capability belongs in the product without dominating the product.

---

# 4. Visual direction

The supplied concept prototype establishes the visual direction.

## Adopted visual character

Kin should feel:

- warm;
- domestic;
- quiet;
- tactile;
- readable;
- spacious enough to breathe;
- compact enough for one-handed use.

The design should avoid the visual vocabulary of business software.

## 4.1 Palette

Use semantic tokens rather than named colors.

Suggested roles:

```css
--bg
--surface
--surface-secondary
--ink
--ink-muted
--line
--accent
--accent-ink
--accent-soft
--warm
--warm-soft
--danger
--danger-soft
```

### Accent

A muted green/teal family fits Kin well:

- trustworthy;
- calm;
- domestic;
- distinct without feeling corporate.

### Warm attention

Warm terracotta/orange may signal:

- catch-up information;
- gentle attention;
- temporary household state.

It must not automatically mean error.

### Danger

Reserve danger styling for actual destructive consequences:

- delete household;
- revoke trusted device;
- remove member;
- irreversible action.

---

## 4.2 Surfaces

Prefer:

- warm neutral page background;
- white/off-white cards in light mode;
- quiet charcoal/brown surfaces in dark mode;
- thin borders;
- little or no dramatic shadow.

Avoid:

- excessive glass effects;
- floating dashboards;
- gradients everywhere;
- neon status colors.

---

## 4.3 Shape

Suggested system:

```text
controls        10–12px radius
list rows       12–14px
cards           14–20px
status pills    fully rounded
```

Rounded shapes should feel approachable but not toy-like.

---

## 4.4 Typography

Use the system font stack.

Prioritize:

- fast loading;
- OS familiarity;
- accessibility;
- zero font dependency.

Suggested scale:

```text
12  metadata
14  supporting copy
16  body / controls
18–20 section heading
26–30 page heading
```

Use weight sparingly.

Hierarchy should come from spacing and size before boldness.

---

# 5. Information architecture

The existing concept correctly limits primary navigation to five destinations.

That constraint remains.

However, Kin's roadmap grows substantially before `0.45.x`, so five permanent feature-specific tabs such as:

```text
Today
Needs
Handoff
Talk
Pulse
```

will not scale indefinitely.

## 5.1 Target navigation model — Directional for 0.45.x

The long-term primary navigation should converge toward:

```text
Today
Lists
Routines
Handoff
More
```

This preserves five stable destinations while giving future product capability somewhere coherent to live.

### Today

The daily loop.

Contains:

- catch-up;
- today's work;
- immediate next items;
- quick capture;
- important near-term context.

### Lists

Things the household needs.

Contains or links to:

- Needs;
- shopping;
- staples/replenishment;
- unassigned household items.

### Routines

Recurring household work.

Contains:

- recurring tasks;
- paused routines;
- household-mode effects;
- schedule context.

### Handoff

Intentional interpersonal context.

Contains two modes:

```text
Handoffs
Talk
```

This preserves the distinction between:

- a message that requires acknowledgment;
- ordinary household conversation.

Talk does not require its own permanent navigation slot.

### More

Everything useful that should not compete with the ten-second loop.

Examples over time:

- Areas;
- Notes;
- History;
- Search;
- Reference records;
- Maintenance;
- People & devices;
- Backup & restore;
- Export;
- Recovery;
- Settings.

"More" is not a junk drawer.

It is the home for infrequent capabilities.

---

## 5.2 `0.14.x` transition

`0.14.x` does **not** need to implement every target destination.

The goal is to shape the app shell so future destinations can arrive without another complete redesign.

Preserve existing user paths during transition where practical.

---

# 6. Vocabulary

## Item — Adopted

Anything the household may need to:

- do;
- buy;
- decide;
- remember.

Capture should not require deciding which subtype it is.

---

## Today — Adopted

A view over household work that matters now.

It is not a separate data model.

---

## Need — Adopted as a view/property

Something the household requires that may not yet have:

- a date;
- an owner.

Needs belong under the broader Lists concept over time.

---

## Handoff — Adopted

Context deliberately passed to another household member with optional explicit acknowledgment.

Example:

> Pickup is 3:10 Thursday. Spare key is in the blue bowl.

Acknowledgment is a deliberate interaction.

It is not passive read tracking.

---

## Talk — Adopted

Lightweight household conversation.

It remains separate from task state and handoff acknowledgment.

Directional placement: inside Handoff rather than as a permanent top-level destination.

---

## Routine — Directional/current according to release state

Recurring household responsibility.

Routines should support real life rather than productivity culture.

Skipping a routine is not failure.

---

## Area — Directional

A lightweight context such as:

```text
Home
Family
Pets
Errands
Car
Garden
```

Areas are not projects.

No nested hierarchy is required.

---

## Note — Directional

Short household reference context.

A note is not:

- chat;
- a task;
- a document editor.

---

## Household mode — Directional

Temporary context that modifies visibility or recurrence.

Examples:

- Vacation;
- Guests;
- Illness/rest.

Modes should not become an automation engine.

---

# 7. Core flows

## 7.1 Today

### Trigger

Open Kin.

### Path

```text
open
↓
optional Catch up
↓
Today
↓
complete/add/claim
↓
leave
```

### Rules

- primary content appears before administrative state;
- completed work remains visually understandable;
- quick add is immediately available;
- current owner and useful timing are visible but secondary;
- no scoring.

---

## 7.2 Catch up

Rename the conceptual experience from the longer:

> Since you last looked

to a shorter visible heading such as:

> Catch up

The accessible or supporting copy may still explain:

> Since you last looked

Show only meaningful changes.

Examples:

- Sam completed something;
- Sam left a handoff;
- a household setting materially changed;
- backup/recovery requires attention.

Do not show:

- app opens;
- page views;
- passive presence;
- every trivial edit.

Catch-up must not become surveillance.

---

## 7.3 Quick capture

Default:

```text
[text field] [Add]
```

Only text is required.

Later editing may add:

- date;
- owner;
- area;
- kind;
- checklist;
- recurrence.

Capture comes before organization.

---

## 7.4 Claim

Claiming should be:

- one action;
- reversible;
- visibly attributed.

Do not silently assign things to another person.

---

## 7.5 Handoff

Flow:

```text
write context
↓
send
↓
recipient sees it
↓
recipient optionally presses Got it
↓
sender sees Acknowledged
```

"Got it" is the deliberate read-receipt exception.

No passive read receipt exists.

---

## 7.6 Talk

Talk is intentionally lightweight.

It should not evolve into:

- Slack;
- threaded chat;
- presence indicators;
- typing indicators;
- read receipts;
- reactions ecosystem.

Its purpose is simply to keep quick household conversation near household context when useful.

---

# 8. Security, sync, and continuity UX

Kin now has enough security architecture that this requires its own UX contract.

## 8.1 Passkeys

Explain passkeys through action, not architecture.

Prefer:

> Use your passkey to continue.

Not:

> Perform WebAuthn assertion.

---

## 8.2 Trusted devices

A trusted device means Kin recognizes that device as authorized household access.

It is not synonymous with:

- a passkey;
- a browser session;
- a household member.

Where trust matters, explain the consequence.

Example:

> Removing this device stops it from syncing new household changes.

---

## 8.3 Sessions

Session expiry should normally feel like:

> Your session ended. Use your passkey to continue.

Not:

> Authentication token expired.

---

## 8.4 Pairing

Pairing should make the sequence understandable:

```text
invitation
↓
identity/passkey
↓
approval
↓
trusted access
```

Knowing the invitation code does not mean the person has joined.

UI wording must preserve that distinction.

---

## 8.5 Recovery

Recovery screens must state:

- what is being recovered;
- what authority is required;
- which old devices/credentials stop working;
- whether history is preserved;
- when recovery is impossible.

Prefer an honest:

> This encrypted history cannot be recovered.

over insecure magical recovery.

---

## 8.6 Deletion

Deletion language must distinguish:

- requested;
- pending;
- finalized.

If a recovery window exists, show it plainly.

If deletion is final, say so.

Old backups and stale devices must not be presented as legitimate ways to bypass deletion.

---

# 9. States every relevant screen must handle

| State | User-facing behavior |
|---|---|
| **Loading** | Skeleton/layout remains stable. |
| **Empty** | One sentence + one obvious action. |
| **Saved locally** | Quiet confirmation if useful. |
| **Waiting to sync** | Work remains usable. |
| **Up to date** | Calm status, not constant celebration. |
| **Offline** | "Offline — changes are safe here." |
| **Conflict** | Explain both valid changes and recovery action. |
| **Device revoked** | Clear terminal security state. |
| **Session ended** | Offer passkey reauthentication. |
| **Recovery needed** | Explain what is required. |
| **Recovery impossible** | Explain the boundary honestly. |
| **Deletion pending** | Show consequence and cancellation boundary. |
| **Household deleted** | Terminal state; stale data cannot silently resurrect. |
| **Storage unavailable/full** | Say what remains safe and next action. |
| **WASM failure** | Explain + retry. |

System-state previews should exist in development/styleguide tooling so designers and agents can inspect these states deliberately.

---

# 10. Household-specific safety

## 10.1 No surveillance

Never add by default:

- last seen;
- online now;
- location;
- passive read receipts;
- app usage reports;
- exact activity timelines;
- "Sam opened this at 8:42";
- completion-performance analytics.

---

## 10.2 Explicit responsibility is allowed; judgment is not

Showing:

> Alex

on an assigned household item is useful.

Showing:

> Alex completed 43% this month

is not aligned with Kin.

---

## 10.3 Tension-safe design

Assume some screens will be viewed during a disagreement.

Use factual language.

Do not editorialize.

Bad:

> Sam has been doing more lately.

Better:

> 4 things are still unassigned.

Often the best choice is to show no comparison at all.

---

# 11. Accessibility

**Target:** WCAG 2.2 AA.

Accessibility is part of feature completion.

## Requirements

### Keyboard

Everything is operable by keyboard.

Visible focus remains obvious.

---

### Touch

Minimum target:

```text
44 × 44 CSS px
```

Prefer:

```text
48 × 48
```

for common daily actions.

---

### Reflow

No loss of function at:

- 320 CSS px;
- 200% zoom.

---

### Contrast

Meet WCAG requirements in:

- light;
- dark;
- forced-colors.

---

### State

Never communicate meaning only through:

- color;
- position;
- animation.

Checked state needs a visible mark.

---

### Motion

Honor:

```css
prefers-reduced-motion
```

Motion cannot be required to understand state.

---

### Focus management

After dynamic updates, focus stays where the user expects.

Dialogs restore focus to their trigger.

---

### Live status

Important dynamic outcomes should use appropriate live-region behavior.

Examples:

- saved;
- completed;
- sync state changed;
- recovery succeeded;
- destructive action failed.

Do not announce every background synchronization event.

---

### Authentication

Do not require users to memorize/transcribe complex credentials.

Pairing and recovery should use platform-supported identity mechanisms and short intentional transfer mechanisms.

---

# 12. Design system

Kin should remain dependency-light.

The design system should primarily be:

- semantic HTML;
- CSS custom properties;
- reusable Web Components where appropriate;
- native browser APIs.

## Required tokens

```css
--bg
--surface
--surface-secondary
--ink
--ink-muted
--line
--accent
--accent-ink
--accent-soft
--warm
--warm-soft
--danger
--danger-soft
```

Also define reusable:

```css
--space-1
--space-2
--space-3
--space-4

--radius-control
--radius-card

--tap-target
--content-width
```

---

## Core components

### `kin-item-row`

Contains:

- explicit complete control;
- title;
- optional metadata;
- optional owner;
- contextual actions.

The entire row should not become one giant ambiguous click target.

---

### `kin-quick-add`

One-field capture.

Enter submits.

After successful add, focus may remain for rapid capture.

---

### `kin-status-chip`

Used for:

- sync;
- local/offline state;
- device/security state where appropriate.

Always contains text.

Never just a dot.

---

### `kin-banner`

Used for:

- Catch up;
- temporary notices;
- security/recovery attention.

Dismissible where appropriate.

---

### `kin-bottom-nav`

Five destinations maximum.

Stable ordering.

Text + icon.

Uses `aria-current="page"`.

---

### `kin-confirm-dialog`

Only where consequence requires explicit confirmation.

Use for:

- deletion;
- revocation;
- member removal;
- irreversible restore actions.

Not every ordinary edit.

---

### `kin-empty-state`

One short explanation.

One primary next action.

---

# 13. Responsive layout

## Mobile — Adopted

Primary target.

Single column.

One-handed.

Bottom navigation.

---

## Wide screens — Adopted through current roadmap

Do not immediately turn Kin into a desktop dashboard.

Prefer:

```text
centered, comfortable column
```

that may grow wider than the original prototype's roughly 480px when richer content benefits.

Directional content width:

```text
~600–680px
```

Before introducing permanent multi-pane layouts, require a real usability need.

---

# 14. Content and voice

Kin should sound like a thoughtful housemate.

## Voice

- short;
- warm;
- plain;
- specific;
- nonjudgmental.

No fake enthusiasm.

No corporate product language.

---

## Examples

Instead of:

> Sync conflict detected.

Use:

> You and Sam both changed this.

Instead of:

> Authentication required.

Use:

> Use your passkey to continue.

Instead of:

> Device unauthorized.

Use:

> This device is no longer trusted.

Instead of:

> Task overdue.

Use:

> Still open from earlier.

Instead of:

> Data restoration failure.

Use:

> The backup couldn't be restored. Your current household is unchanged.

---

# 15. Privacy and trust in UI

The product must make its trust boundaries understandable.

## Show

- sync state;
- trusted-device state where relevant;
- backup/recovery status;
- deletion consequences;
- what action is required.

## Do not expose casually

- key epochs;
- cryptographic primitives;
- token IDs;
- internal sequence numbers;
- storage internals.

Those may exist in diagnostics, not ordinary household UX.

---

# 16. Growth toward v0.45.x

The app shell created in `0.14.x` should survive the roadmap.

Future capabilities should fit roughly as follows:

| Capability | Likely home |
|---|---|
| Checklists | Today / item detail |
| Richer routine schedules | Routines |
| Shopping | Lists |
| Staples/replenishment | Lists |
| Household modes | Today + Routines |
| Planning dates | Today / item detail |
| Calendar interoperability | More / contextual settings |
| Useful history | More / entity details |
| Search | Global shell / More |
| Pins/quick access | Today |
| Playbooks | Routines / More |
| Local reminders | Contextual settings |
| PWA/install | Browser/platform |
| Reference records | More |
| Maintenance | More |
| Attachments | Entity detail |
| Responsibility | Item/Routine detail |
| More household members | People & devices |
| Limited/guest members | People & devices |
| Export/restore/migration | More / continuity |
| Backup/disaster readiness | More / continuity |

A feature should not earn a permanent navigation destination merely because it exists.

---

# 17. v0.14.x design consolidation scope

`0.14.x` should establish the shell, not implement the entire roadmap.

## Pass 1 — Structure

Focus on:

- global shell;
- navigation;
- spacing;
- typography;
- tokens;
- cards/list rows;
- primary Today experience;
- preserving existing functionality.

No large visual flourishes.

---

## Pass 2 — States and responsive behavior

Focus on:

- loading;
- empty;
- offline;
- sync;
- recovery;
- revocation;
- deletion;
- narrow screen;
- keyboard;
- zoom;
- forced colors;
- dark mode;
- reduced motion.

---

## Pass 3 — Polish and prototype alignment

Focus on:

- warm visual character;
- wording;
- hierarchy;
- focus management;
- visual consistency;
- design-system cleanup;
- removal of obsolete styles;
- docs;
- prototype comparison.

Then stop for human design critique.

Do not immediately continue redesigning based solely on agent preference.

---

# 18. Open design decisions

## UX-D1 — Final `0.14.x` navigation transition

**Directional choice:** Today / Lists / Routines / Handoff / More.

**Open:** whether `0.14.x` adopts the full destination set immediately or transitions while preserving existing routes.

---

## UX-D2 — Talk placement

**Leaning:** preserve Talk functionality but place it as a mode inside Handoff rather than permanent navigation.

Reason:

- both are interpersonal household context;
- Talk does not justify consuming 20% of permanent navigation as Kin grows.

---

## UX-D3 — Pulse

The existing prototype's Pulse expresses a valuable desire:

> "How is the household doing?"

But numeric shared-load comparison risks conflicting with Kin's no-scorekeeping principle.

**Directional choice:** retire Pulse as a permanent tab.

Useful pieces can move elsewhere:

- sync/privacy → More / trust;
- open household needs → Today or Lists;
- descriptive household state → Today;
- history → More.

Do not ship comparative partner completion bars.

---

## UX-D4 — Desktop layout

**Adopted for now:** centered primary column.

The wide-screen application keeps the same five primary destinations in a
compact horizontal navigation row above a centered 600–680px content column.
It does not use a permanent desktop side rail. Mobile keeps the five-item
bottom navigation.

Revisit only when real workflows demonstrate that simultaneous panes reduce friction.

---

## UX-D5 — Household name

**Directional:** allow household identity in the shell eventually.

Until then:

```text
Kin
Alex + Sam
```

or similar calm context is sufficient.

---

# 19. UX validation

Kin does not need behavioral analytics to validate the product.

## Test with real people

Prefer paired household testing.

Useful tasks:

1. Open Kin and explain what matters today.
2. Add something while pretending to walk out the door.
3. Claim something unassigned.
4. Complete something.
5. Leave a handoff.
6. Acknowledge it on another device.
7. Explain current sync state.
8. Recover after going offline.
9. Explain the difference between passkey, trusted device, and current session in their own words.
10. Find backup/recovery without guidance.

## Important questions

- Did either person feel monitored?
- Did either person feel scored?
- Was any security step surprising?
- Did "trusted device" make sense?
- Did users know what was safe during failure?
- Could they add something in seconds?
- Did they understand Handoff versus Talk?
- Did the navigation feel household-oriented rather than app-oriented?

---

# 20. UI review checklist

For any significant UI PR:

### Daily use

- [ ] Ten-second loop remains intact.
- [ ] Capture does not require categorization.
- [ ] No unnecessary confirmation step.
- [ ] Primary action is obvious.

### Accessibility

- [ ] Keyboard works.
- [ ] Visible focus.
- [ ] Focus remains logical after rerender.
- [ ] Screen-reader status tested.
- [ ] 320px works.
- [ ] 200% zoom works.
- [ ] Forced colors works.
- [ ] Dark mode works.
- [ ] Reduced motion respected.
- [ ] Touch targets are at least 44px.

### State

- [ ] Empty.
- [ ] Loading.
- [ ] Offline.
- [ ] Pending sync.
- [ ] Error.
- [ ] Revoked device where relevant.
- [ ] Recovery state where relevant.
- [ ] Destructive state where relevant.

### Household safety

- [ ] No scoring.
- [ ] No surveillance.
- [ ] No passive read receipts.
- [ ] No judgmental copy.
- [ ] Attribution is factual.

### Privacy

- [ ] Claims are specific and true.
- [ ] No new tracker or analytics dependency.
- [ ] No unnecessary third-party request.
- [ ] Sensitive architecture terminology stays out of ordinary UI.

### Architecture

- [ ] Uses existing Rust/WASM/domain contracts.
- [ ] Does not duplicate canonical state in UI-only logic.
- [ ] Native platform capabilities considered before dependencies.

---

# 21. Final design principle

Kin should progressively become more capable without progressively becoming more complicated to use.

The product should feel like:

> **a quiet shared place that remembers what the household needs**

not:

> **software for managing the people you live with.**

That distinction is the design boundary.

# 22. v0.15.x Household Areas implementation notes

Areas answer “Where or what part of household life does this belong?” They are
optional context for supported household content. Use household language such
as “Areas help keep household things together.” Do not present Areas as
projects, folders, permissions, workspaces, or a required taxonomy.

Quick capture remains title/text → add. Area choice is never part of the
capture form. Area management is reached from More and offers a short create
form plus direct rename/archive actions. Existing assignment context stays
visible when its Area is archived; archived Areas are not offered for new
assignments. “No area” remains an ordinary choice, and an assignment can be
cleared without changing the Item.

The initial contextual assignment control appears beneath Item text as a
secondary native select. Keep it labeled “Area for [item text]”, keyboard
operable, at least 48px tall, and reflowing at 320px and 200% zoom. Names are
plain text. Conflicting offline duplicate names remain separate stable Areas
and receive a short ID suffix in selection/management labels until renamed.
