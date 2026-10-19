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

## 5.1 Target navigation model — Adopted (household workspace candidate)

The primary navigation is now:

```text
Today
Lists      (To do · Shopping · Staples)
Routines   (Routines · Reusable checklists)
Updates    (Handoffs · Talk)
Household  (Overview · Notes & reference · Areas & status · People & devices · Privacy & recovery)
```

"Updates" is the presentation label for the former Handoff destination and
"Household" for the former More page; `#handoff`, `#more`, `#lists` and
`#search` keep working as aliases (see [WORKSPACE-UX](WORKSPACE-UX.md) §2).
The original directional wording follows for history:

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

Capture is context-sensitive (Adopted, v0.41.0, revised by the household
workspace candidate): the Today capture asks *what* the item is (Task or
Shopping item), *when* it matters (Today by default, Tomorrow, a date, or no
date) and whether to pin it; it creates an ordinary `need` or `shopping`
record and sets the planning date explicitly, never a new classification.
To do, Shopping, and Staples each carry a single-field capture fixed to that
list, so adding eggs from Shopping creates a Shopping item. The confirmation
names the destination and an inline result says "Saved on this device." or
"Saved here. Waiting to sync."; a failure says "Couldn't save. Your text is
still here." with Try again beside the field.

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

Household chat is separate and sits beside Talk under Updates → Chat ([ADR 0008](decisions/0008-household-chat.md)); this list still holds for Talk.

---

# 8. Security, sync, and continuity UX

Kin now has enough security architecture that this requires its own UX contract.

## 8.1 Passkeys

Explain passkeys through action, not architecture.

Prefer:

> Use your passkey to continue.

Not:

> Perform WebAuthn assertion.

### Passkey-first unlock — Adopted (v0.41.0)

Once a device holds a passkey that can unlock Kin, the lock screen reads
"Welcome back" with `Unlock with passkey` as the only primary action and
`Use recovery key` as a secondary control that reveals the recovery form. The
recovery key is a backup, never the everyday login. Offline, the screen says
plainly that passkey unlock needs a connection and shows recovery directly.
First run is a welcome, a "Save your recovery key" step, then create/join
choices; passkey unlock is offered as soon as the device holds a household
credential. Security settings state whether passkey unlock is on.

### First-run friction fixes — Adopted (v1.0 reality check, #163)

Testers on real phones found three setup snags:

- **No retyping the recovery key.** The setup step shows the key with Copy
  key and asks the person to tick "I've saved this key somewhere safe". It no
  longer asks them to paste it back. The form carries off-screen
  `username`/`new-password` fields so the browser can offer to save it as a
  password named for the key's label ("Kin recovery key K-7F3A"; one shared
  name would let a second device's key overwrite the first). The recovery
  unlock form asks for `current-password` under the current key's name, so a
  saved key can autofill; key replacement offers the new key under its own
  label. The copy says not to count on the browser's offer: copying the key
  is the main path. The setup step shows only the key and its controls (with
  Back), not the welcome text above it, and focus starts on its heading.
- **Install help on iPhone and iPad.** No iOS browser offers an install
  prompt, and the Home Screen app keeps its own storage, separate from the
  browser it was added from. So the welcome screen in an iOS browser shows
  Home Screen steps for that browser *before* setup (Safari, including the
  iOS 26 ••• menu and its "Open as Web App" switch; Chrome on iOS 16.4+;
  other browsers, falling back to Safari). An app's built-in browser
  (Instagram, the Google app…) can't add to the Home Screen, so it's told to
  open the page in Safari. More has the same steps under Install Kin. Inside
  the installed app, nothing is shown.
- **Automatic device name.** Create and join name the device from the
  browser and platform ("Chrome on iPhone"; just "iPhone" in the installed
  app) and say so in one line. Nobody types a name; a nickname comes later
  (§8.2).

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

Trusted devices (v1.1, #71):

- Devices are grouped by member: "Your devices" first, then one group per
  other member. Each group is a labelled list.
- Each row leads with the device's name: its nickname, else its automatic
  name, else "New device · " and the first four characters of its sync code
  when it hasn't synced a name yet. After the name come the automatic name (when
  a nickname hides it), "This device" for the device in your hand, and
  Trusted or Revoked.
- Your own devices have **Rename**, which opens an inline Nickname field
  (at most 32 characters) with Save nickname, Cancel and, when one is set,
  Remove nickname. Escape cancels and returns focus to Rename. Rename's
  accessible name includes the device ("Rename Kitchen tablet").
- Other members' devices can't be renamed. Revoke and the other controls
  name the device by the same displayed name.
- The page says why names are safe to set: only household members can see a
  nickname.

---

## 8.3 Sessions

Session expiry should normally feel like:

> Your session ended. Use your passkey to continue.

Not:

> Authentication token expired.

---

## 8.4 Pairing

People & devices starts with two explicit actions before any scanner or code:

- **Invite another person** explains that Kin creates a separate household member
  identity with role-based access.
- **Add my device** explains that this remains the same person and member ID on
  another phone or computer, and that a member is not notified of their own
  changes on another device.

The chosen outcome remains visible during QR and manual entry. A generic
“Pair” action must not make the member/device result implicit. The complete
onboarding and platform checks are in
[Member and Device Identity Acceptance](IDENTITY-PAIRING-ACCEPTANCE.md).

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

## 8.8 Notifications on this device (v1.1, #85)

Copy for every state, the Home Screen requirement on iPhone and iPad, and the
one-line promise are in [PUSH](PUSH.md#what-a-member-sees). Native buttons and
a native select, 48px targets, a polite status after each change, alert
semantics on errors, and focus returning to the section's first control.

## 8.7 Home screen name and icon (v1.1, #78)

In Identity & defaults, admins only (the section isn't in the DOM for anyone
else):

- **Toggle:** "Show our name and icon on home screens", off by default.
  Turning it on opens the form; nothing is published until Save.
- **Fields:** Short name (prefilled from the household name, up to 12
  characters, "Shown under the icon"), Description (optional, up to 200).
- **Icon:** "First letter of the household name" (default) or "Upload an
  image", with a preview of the icon and of the round crop some Android
  launchers use, labelled for screen readers. Save and Stop showing are
  disabled while a save is in flight, and while an uploaded image can't be
  used.
- **Before the first publish:** "Your household name and icon will be stored
  by the Kin service without encryption so devices can show them on the home
  screen. Everything else stays encrypted." Save stays disabled until "I
  understand the name and icon are not encrypted" is checked.
- **Platforms:** "Computers and Android phones pick up changes on their own,
  usually within a day. On iPhone and iPad, remove Kin from the Home Screen
  and add it again to see a change."
- **Save home screen** reports in a polite status ("Saved. Installed apps show
  it the next time they check for changes."). Errors use alert semantics. A
  conflict reloads the latest and says another admin changed it.
- **Stop showing** (or unchecking the toggle) asks for confirmation, deletes
  the service's copy and returns focus to the toggle.
- After a household rename, the status says home screens still show the old
  name until Save.

## 8.9 QR codes and signing in with a phone (v1.1, #93)

**Invitation QR (#97).** Shown on a waiting invitation, labelled "QR code for
this invitation. Scan it with the joining device's camera.", beside the typed
code, Copy code and Share invitation. The QR code goes once the invitation is
claimed (the code, Copy and Share stay while the claim awaits approval). An
expired or revoked invitation shows "This invitation ended: it expired." /
"…: it was revoked.", with no QR code and no code. On the join screen, "Scan invitation" opens the
scanner in place; a scanned invitation fills the field ("Code filled in from
the invitation. Check it, then continue."), and any other Kin code says
"That Kin code isn't an invitation. Scan the invitation's code, or type it."

**Scanner (#96).** The camera starts only on "Scan a code" and stops on a
result, Cancel, leaving the view or locking. Every state says what to do next
(starting, looking, blocked, no camera, insecure, lost, reader failed), and
"Type the code instead" is always offered.

**Computer: Sign in with your phone (#100).** A choice on the signed-out
screen ("You're already signed in to Kin on a phone. Scan this computer's code
with it, then type the 6-digit code it shows.") and a button on `/pair`.

- Waiting: "On your phone, open Kin → People & devices → Add a computer →
  Scan.", the QR code, "This code changes in 01:52" (updated silently) and
  Cancel. The code replaces itself four times, then "The sign-in code
  expired. Nothing was signed in." with "Show a new code".
- Approved: "Your phone approved this computer. Type the 6-digit code shown on
  your phone.", a "6-digit code" field and "Sign in", "The code works for
  01:40", Cancel. A wrong code, from the service: "That code didn't match. 2
  tries left. Check the code on your phone and type it again." Three: "That code was wrong too many times,
  so the sign-in request ended. Nothing was signed in."
- Ended (cancelled on the phone, expired, refused): "This sign-in request
  ended. Nothing was signed in." with "Show a new code" and Back, and "Sign in
  as someone else" when the computer offered a device it already had.
- A sign-in link opened in the browser of a device that's signed in, rather
  than scanned in Kin: "That was a computer's sign-in code. To approve it, choose Add a computer below
  and scan it there."

**Phone: Add a computer (#101).** In People & devices, for Adults whose device
has its sync key.

- Scan: "On the computer, open Kin and choose Sign in with your phone. Then
  scan the code it shows." An invitation code or anything else is explained;
  "Type the code instead" says a computer needs its QR code.
- Review: "Approve this computer?", the computer's automatic name, "It will be
  signed in as you…" (new, or already one of your devices), the warning
  **"Only approve a computer that's in front of you."**, "Approve with
  passkey" and Cancel. A dismissed passkey leaves the review open: "…The
  computer was not approved."
- Code: "Type this code on the computer", the code in large selectable text,
  "Only type it on “Chrome on Windows”, the one in front of you.", "The code
  works for 01:58", Cancel.
- Done: "The computer is signed in" and Done. Ended: what happened, "Scan
  again" and Done.

---

## 8.10 The family fridge (#317)

Household → Fridge (and **Draw on the fridge** beside Today's date) opens a
shared board, decided in [ADR 0011](decisions/0011-family-fridge.md).

- **One door, every screen.** A fixed 3:4 portrait door scales to fit: on a
  phone the width decides, on a short wide screen the height does, never past
  720 px wide. There is no pan or zoom on the door; the page around it scrolls
  and zooms as usual. Only the door sets `touch-action: none`.
- **Tools** are ordinary named buttons, each at least 44 px: eight colours
  (Black, Red, Orange, Yellow, Green, Blue, Purple, Brown), three widths
  (Thin, Medium, Thick), Eraser, Undo and Redo. Colours are palette indices,
  remapped for dark mode; under forced colours every stroke is drawn in the
  system text colour.
- **Input.** Finger, pen or mouse. While a pen is down, touches are ignored
  (a resting palm draws nothing); a second finger turns a finger stroke into a
  gesture and nothing is drawn. Strokes are saved on pen-up.
- **Eraser and undo.** The eraser removes whole strokes. Undo and Redo cover
  this device's own drawing and erasing in this visit; a stroke someone else
  erased or restored meanwhile is left alone.
- **What it says.** A polite line under the door summarizes the fridge ("3
  drawings by Sam, Alex and you"), and adds "Waiting to send." while changes
  haven't reached the household. A full fridge says so: "The fridge is full.
  Erase something or clear it to draw more." Nothing counts, ranks or
  notifies anyone.
- **Magnets** (#322) are named buttons over the door: an emoji, one of twelve
  Kin-drawn magnets or a short note, put up through a dialog (a bottom sheet on
  phones) in one of nine named places. Arrow keys move one 1% (Shift 10%),
  "Move to" picks a place, dragging works too, and Delete or "Take it down"
  removes it; undo puts it back. Nothing needs dragging.
- **Clearing** asks first, with "Keep it" focused, and anyone can bring back
  the latest clear.
- **Who can use it** (#323): Adults always draw; the household admin sets
  Limited and Temporary members to Draw, Look only (the fridge shows without
  its tools) or No access (Household → Identity & appearance → Who can use the
  fridge, with a passkey).
- Drawing is a path-based gesture and has no keyboard equivalent.

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

Exception: household chat's read receipts, typing and "online now" are visible, switchable per member, reciprocal and never kept as history ([ADR 0008](decisions/0008-household-chat.md)). "Last seen" and location stay out.

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

## Wide screens — Adopted (household workspace candidate)

Kin is still not a desktop dashboard. Wide screens get:

```text
left navigation  |  readable content column (≤ 720px)  |  detail column only while an item is open
```

There are no permanent information rails, widgets or statistics. The detail
column is conditional; closing the item removes it. See UX-D4 and
[WORKSPACE-UX](WORKSPACE-UX.md) §4.

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

**Adopted (household workspace candidate):** persistent left navigation with
a readable content column and a *conditional* detail column.

From 720px the five primary destinations sit in a left rail beside a content
column of at most 720px; the header carries Search, a truthful sync chip and
Lock. From 1180px, opening an item adds a detail column beside the list; at
720–1179px the detail replaces the list with a Back control; below 720px it
is a full-height sheet. The column exists only while an item is selected,
and one `<kin-item-detail>` element is re-homed between the three
presentations so drafts survive resizing. Mobile keeps the five-item bottom
navigation with five equal tracks. The contract is
[WORKSPACE-UX](WORKSPACE-UX.md).

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
- [ ] No passive read receipts (chat's visible, switchable receipts follow [ADR 0008](decisions/0008-household-chat.md)).
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

# 23. Chat unread marker and badges (#133)

- Where the member left off is a private read position, kept apart from read
  receipts: it works with receipts off and is shown to no one.
- Opening Chat scrolls to a "New messages" divider above the first unread
  message, with "Jump to latest" to skip to the end. The divider stays while
  the member reads and is placed again the next time they return.
- **Updates → Chat** shows the unread count (`99+` past 99) with the
  accessible name "N unread". Reading on one device clears it on the member's
  other devices once they sync. When any unread message mentions the member
  (or everyone), the count starts with "@" and the name becomes "N unread,
  includes mentions of you".
- **Mentions (#130).** Typing "@" in the message box opens a list (a
  combobox: Up/Down, Enter or Tab, Escape; tap to choose) of the members who
  can read chat, plus @everyone. The text stays plain "@Name"; the sent event
  records who was meant. Mentions show in bold underline, a message that
  mentions you has a mark on its row, and search can show only messages that
  mention you. Limitation: a mention is highlighted by its current label, so
  a member renamed later no longer matches the old "@Name" text, which then
  shows as plain text. Push notifications stay generic ([ADR 0008](decisions/0008-household-chat.md)).
- Where the browser supports the Badging API, the installed app's icon shows
  the same count, set on the device from decrypted state.
- **Decision: the home-screen badge clears when Kin locks.** The badge is only
  a number, but a number on a locked app still tells anyone who sees the
  screen that the household is active. Locking stops the chat room, which
  clears the count and the badge; unlocking brings both back from the saved
  position. Messages that arrive while locked are counted at the next unlock.

# 24. Pinned chat messages (#131)

- **Pin** and **Unpin** are in a message's actions for anyone who can post.
  Up to 10 messages are pinned per household; pinning an 11th says "You can
  pin up to 10 messages. Unpin one first." and sends nothing.
- A **Pinned messages** region sits above the conversation when anything is
  pinned. Its bar is one button showing the latest pin; pressing it opens the
  list of all pins (newest first), each with who pinned it, a button that
  goes to the message (loading the stretch around it if needed) and **Unpin**.
  Escape closes the list. The bar and list are plain buttons in the tab
  order.
- Deleting a pinned message for everyone (or an admin removing it) takes it
  off the list. "Delete for me" only hides it from this member's list.

# 25. Online now (#128)

- A green dot and "Online now" mark members who have Kin unlocked and visible
  on any device: a line at the top of Chat ("Online now: Sam, Alex") and a dot
  after an author's name on their messages (with "online now" for screen
  readers). The line is plain text, not announced on every change.
- Nothing says when someone was last here, and nothing is kept: a member is
  online for at most 70 seconds after their last heartbeat, a hidden or locked
  device says "away" at once where it can (not when the page is closed or Kin
  locks: the keys go first, so the others see it run out within 70 seconds),
  and a reload starts empty.
- **Settings → Chat → Show when I'm online** (on by default) syncs to all of
  a member's devices. Turning it off stops sending and also hides everyone
  else's status, and the copy says so. Members with no chat access neither
  send nor see it; read-only members can do both.

# 26. Turn a message into a task, handoff or note (#132)

- A message's ⋯ menu offers **Add to Shopping**, **Add to To do**, **Make a
  handoff** and **Save as a note** to any member who can read the chat
  (read-only members too: the records are the household's, not the chat's).
  Each opens one dialog with the message's text, editable. Items and handoffs
  take it as one line; a note takes the message's first line as its title and
  all of it as the body.
- The dialog says everyone in the household will see the result, including
  members who can't read the chat when there are any, and that it is a copy.
- A photo or file on the message is offered as an unchecked box per file
  (items and notes only; handoffs take text). Chosen files are re-encrypted as
  ordinary household attachments of the new record; unchosen files are not
  copied. A file that fails is named after the record is saved.
- Saving goes through the same commands as typing the record in. Nothing about
  the message (its id, author or time) is stored with it, so deleting the
  message or the record never touches the other. The dialog then says
  "Added to Shopping." with **Open it** (items) and a link to the list.

# 27. Quick polls (#135)

- The composer has a **Poll** button for members who can post. It opens a
  dialog with a question, two to ten options (add and remove buttons, each
  option a labelled text field) and a "Allow choosing more than one answer"
  checkbox.
- A poll is a message. Its options are a native `fieldset` of radio buttons
  (or checkboxes for multiple choice) with a legend of the question. Choosing
  votes at once; a member can change or clear their vote while it is open.
- Results are text, not only bars: each option shows its count and who voted
  for it by name, so nothing depends on colour. Your own vote, clearing and closing are announced politely.
- The poll's author has **Close poll**; a closed poll shows "Closed" and its
  final result, and its options are disabled.
- Read-only members see the results and cannot vote. Deleting a poll for
  everyone removes the question, options and votes. Replying to a poll shows its
  question.

# 28. Chat in export and restore (#136)

- Under **Backup and move**, a device that can read chat shows a checkbox,
  **Include chat (messages, photos, files, voice)**, checked by default. Under
  it, a polite status line gives the size before anything is made: how many
  chat events and photos or files, and about how many megabytes. The box is
  absent when there is no chat yet or the device has no chat access.
- Messages deleted for everyone are only deleted placeholders in the export,
  and the line says so; "delete for me" lists are the exporter's own.
- If the archive's size limit leaves older photos and files out, the message
  after the export says how many were left out and that they stay in Kin.
- Restore checks the whole file first. The summary names the chat it holds
  (events, photos, files). After restoring, the message says the chat will
  appear once the device is approved. If only the chat could not be saved, the
  household is still restored and the message says to restore the same export
  again to finish the chat.
- The checkbox is a native control with its label and the size line as its
  description; the progress bar covers household and chat events together.

# 29. Voice messages (#134)

- The composer has a **Voice** button. The first tap asks the browser for the
  microphone; Kin asks for nothing at page load. If it is refused, missing or
  in use, a plain message says which, with a Close button; if the browser
  can't record in a format Kin can send, the message says so.
- Recording shows a running time and **Stop** and **Discard** buttons, and
  stops by itself at five minutes (announced). The microphone is released the
  moment recording stops, is discarded, or the page is hidden or locked.
  Hiding the page keeps what was said for review; locking drops it.
- After stopping, the recording can be played back with the browser's native
  audio controls, then **Send voice message** or **Discard**. A failed send
  keeps the recording.
- In the log a voice message is a group named "Voice message from Sam, 0:42"
  with a Play/Pause button, a waveform that is also a native slider (arrow
  keys move through the message; the slider reads "0:21 of 0:42"), the time,
  and a 1×/1.5×/2× speed button. Nothing is downloaded or decrypted until it
  is played. If it can't be played the message says so beside it.
- There is no transcription and no automatic captioning; the waveform is drawn
  by the engine from the recording on the sender's device. A voice message is
  an ordinary attachment: it is sealed, kept, expires, exports and is deleted
  exactly like any other file.

# 30. Attaching in chat: paste, drop, camera, progress, retry (#115, #116)

- **Paste.** Pasting a picture or file into the message box adds it to the
  files to send. When files can't be added (read-only, editing, recording,
  sending) the message box says so. A dropped folder is refused by name as
  empty. Pasted text, including text that also carries a picture (as a
  spreadsheet does), pastes as text.
- **Drop.** On a desktop, dragging files over the chat outlines the composer
  and dropping adds them. When the member can't post, is editing or
  recording, or is already sending, no outline shows and the drop is
  refused with a message (the browser never opens the file in the tab).
- **Camera.** On a phone or tablet (a touch screen as the main pointer) a
  **Camera** button beside Attach opens the device's camera for one photo. It
  is not shown on a desktop.
- **Every addition is announced** ("2 files added.") and limited like the
  Attach button: up to ten files, 25 MB each.
- **Progress and Cancel.** While Send prepares the files, each listed file
  shows a native progress bar named "Preparing <name>", and **Cancel sending**
  stops it. Cancelling leaves the files and the caption where they were and
  says so.
- **Retry.** If sending fails, the caption and files stay, the message says
  so, and a **Retry** button beside Send tries again with the same draft.
  Removing the last file hides it.


# 31. Approachable first use and clearer feedback (#261)

These slices of #261 were built from the epic's written direction **before**
the usability sessions it calls for (#262). They are hypotheses to test, not
validated results; #262 and #269 stay open until real household members have
tried them.

- **Welcome and capture question (#263, #265).** The "Welcome home" card and
  the "What would you like to remember?" question come from the
  `kin-ui-overhaul` track (#276, #273).
- **Where it goes (#265).** A line under the Today field says where the item
  goes before Add, such as "Adds to Shopping, planned for today." It is read
  with the field.
- **Truthful save feedback (#267).** With sync on, a capture says "Saved here.
  Waiting to sync." and keeps saying so. It changes to "Saved and sent to your
  household." only after a sync cycle ends with nothing unaccepted left in this
  device's outbox, and the status region announces it once. It never says
  anyone has received or read it. Without sync it says "Saved on this device."
- **Plain destinations (#266).** Lists, Routines, Updates and Household each
  have one plain sentence under their heading; Updates drops Chat from it when
  the household's chat policy leaves a member without Chat. Names, order and
  routes of the five destinations are unchanged.
- **Joining (#264).** While waiting for approval, the joining device says who
  checks the key and approves next. Opening a code link without choosing a path
  first explains what happens and that a code never creates a new household.
- **Named, truthful action feedback (#267).** Completing, reopening or
  archiving says which item changed ("Marked “Milk” done.", long names
  shortened) and, with sync, "Waiting to sync." or "It will sync when you're
  connected." Once the relay has accepted everything waiting, the status says
  "Sent to your household." once. A lock replaces the line, so no item name
  survives it. The empty Shopping list says how to add to it.
- **Consistent identity forms (#268).** Path statements, next steps and the
  name and nickname forms share spacing, 48 px targets and theme tokens; long
  names and device labels wrap rather than widening a 320 px screen.
