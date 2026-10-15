# Web Component Contract

**Status:** Current through v0.25.0 Search & Filters; earlier version sections are historical contracts.

## `<kin-app>` structure (refactor track)

`web/components/kin-app.js` is a small element: lifecycle callbacks, three
symmetric listener tables (element, document, window) and one-line stubs for
the methods called from outside it. Its behavior lives in plain controller
classes under `web/components/app/`, each constructed with one explicit
context object from `app/context.js`:

| Context key | Module | Responsibility |
| --- | --- | --- |
| `session` | `session.js` | unlock, open, lock, auto-lock; the session guard |
| `sync` | `sync.js` | sync coordinator, authorization checks, sync chip |
| `peers` | `peer-channel.js` | content-free BroadcastChannel invalidation |
| `refresh` | `refresh.js` | projection refresh, catch-up, timed refresh |
| `append` | `commands/append.js` | the single command append path |
| `items`, `bulk`, `conversations`, `routines`, `records` | `commands/*.js` | household commands by domain |
| `attachments` | `attachments.js` | capture, viewer, previews, the one file input |
| `navigation`, `detail` | `navigation.js`, `detail.js` | routes, shortcuts, the item-detail view |
| `appearance` | `appearance.js` | personal and household appearance |
| `status`, `render` | `status.js`, `render.js` | busy/status/alerts, onboarding, update notice; rendering |
| `shell`, `views` | `shell.js`, `views.js` | building the persistent shell and pages |

The element keeps the state and DOM references (`app.store`, `app.state`,
`app.today`, …). `initializeAppState(app)` sets them and the bound handler
properties; controllers read and write them through `this.app`. There are no
mixins or prototype patches: a controller reaches another only as
`this.ctx.<key>`. Methods that regression scripts or `<kin-security>` call on
the element (for example `appendCommand`, `refreshFromEvents`,
`lockHousehold`, `notifyPeerLock`) keep element stubs, and controllers call
them through the element so a test that replaces one still intercepts every
internal call. Slice 8 replaces the script-facing stubs with one documented
test hook.

Shared component helpers live in `web/components/shared/`: `dom.js`
(`button`, `text`, `section`, `message`, `field`), `icons.js`, `focus.js`
(`captureFocus` / `restoreFocus`), `props.js` (`defineProps`: generated
setters with microtask-coalesced rendering, identity skipping and
`flushRender`), `operation.js` (`OperationGuard`, the guarded single-operation
runner used by `<kin-household>` and `<kin-security>`) and `session-guard.js`.

### Large components: element shell plus parts (refactor track, Slice 5)

`<kin-household>`, `<kin-security>` and `<kin-today>` follow the same shape
as `<kin-app>`. The element file keeps its lifecycle, its state, a few small
UI helpers, and a one-line stub for every method called from outside it
(regression scripts, `<kin-app>` controllers, unit tests). Everything else
lives in part classes in a folder named after the element:

| Element | Parts |
| --- | --- |
| `<kin-household>` | `household/`: `api.js` (connection, requests, sync status), `auth.js` (passkey registration and login, WebAuthn helpers), `pairing.js`, `membership.js` (devices, members, invitations), `lifecycle.js` (deletion, leaving), `views.js` |
| `<kin-security>` | `security/`: `views.js`, `protection.js` (setup, replacement, passkeys), `unlock.js`, `archive.js` |
| `<kin-today>` | `today/`: `sections.js` (the Today composition), `selection.js` (bulk selection), `focus.js` (keeping focus across re-renders) |
| `<kin-item-detail>` | `item-detail/`: `sections.js` (checklist, files, planning, responsibility, Area, reminder, pin, archive) |
| `<kin-notes>` | `notes/`: `notes.js` (the Note form and list), `references.js` (reference records and their maintenance log) |

The element builds its parts once, in its constructor, from a `PARTS` table,
with one shared context `{ host, ...parts }`. A part reaches the element as
`this.host` and the other parts as `this.ctx.<part>`. A part never holds state
of its own: fields stay on the element, so the lifecycle callbacks and the
lock path see all of it in one place.

`<kin-playbook-editor>` (the reusable-checklist form with its validation) and
`<kin-routine-schedule>` (one Routine's schedule disclosure) are small
elements inside `<kin-routines>`. Each dispatches its household command
(`kin:save-playbook`, `kin:change-routine-schedule`) itself and reports
cancel, toggle and draft changes to `<kin-routines>` as non-bubbling events,
so which schedule is open and its unsaved choice survive re-renders.
`<kin-routines>` keeps the editor's controls under their older field names
(`playbookTitle`, `playbookEntries`, …) for the regression scripts. Both
elements keep their own disabled state, because a schedule's Change button
also depends on whether the choice differs.

`<kin-item-detail>` takes its inputs through `defineProps` too. Methods that
change what it shows without changing an input (`setFeedback`,
`clearFeedback`) schedule a render themselves, so the next `update()` shows
them even when every input is unchanged. A component that builds its DOM in
`setup()` must not name a field after a built-in `HTMLElement` property such
as `title`.

`<kin-bulk-bar>` (`kin-bulk-bar.js`) is the To do and Shopping bulk bar. It
owns its controls, text, visibility and focus handoff, and it reports button
presses to its list as a non-bubbling `bulk-bar-action` event. The list keeps
the selection and sends the `kin:bulk-*` commands, so `<kin-app>` sees the
same events as before. Its controls stay reachable as `list.bulkBar.undo`,
`.toolbar` and so on.

### Incremental rendering (refactor track, Slice 4)

The engine reuses every decoded projection section whose revision did not
change ([ABI](ABI.md#section-revisions)), so an unchanged section reaches the
views as the same array. Views skip work by identity: each data setter of
`<kin-today>`, `<kin-routines>`, `<kin-notes>`, `<kin-areas>`,
`<kin-handoff-list>`, `<kin-talk-list>`, `<kin-catch-up>`, `<kin-pulse>` and
`<kin-search>` compares the incoming value with the one it holds and renders
only when it differs. `<kin-today>` gets this from `defineProps`: a setter
schedules one microtask render, and `update(props)` assigns several inputs
and renders at once if any changed. Otherwise it only applies a focus that a
command remembered for the render. The comparison is with the component's current value, not with what
`renderState()` last passed, so a value assigned from elsewhere is still
replaced by the next render. `responsibilityContext()` returns the same object
while its inputs are unchanged. Decoded state is never mutated, because reused
arrays are shared between states.

`refreshFromEvents()` takes one focus snapshot (`captureFocus`) before busy
disables the focused control, recording which list or composer owns it. After
the refresh it restores focus to the same control if it survived. Otherwise
the owning list or the routines view restores the equivalent control through
its own `restoreFocus`, and a composer puts focus back in its input.

## Household workspace candidate (unversioned)

The desktop-first workspace revision keeps every boundary below and changes
presentation only. `<kin-app>` owns the route (`web/routes.js`), the header
tools, the five primary destinations and their segments, the single
`<kin-item-detail>` instance and where it is mounted (sheet, inline column or
side column), per-route scroll memory, and the multi-step Today capture
(`web/capture-plan.js`). `<kin-today>` composes Today from the projection
through `web/today-view.js` (pure filtering/grouping; no recurrence or
validity logic) and renders one list at a time for Lists. `<kin-item>` is a
simplified row that dispatches `kin:open-item`; `<kin-item-detail>` holds
checklist, photos/files, planned date, responsibility, Area, reminder, pin,
archive and history for one canonical item id and dispatches the existing
item intents plus `kin:close-item-detail`. `<kin-reminder>` replaces the
`window.prompt` reminder with labelled date/time inputs
(`web/reminder-time.js`) and dispatches the unchanged
`kin:set-local-reminder` / `kin:cancel-local-reminder`. `<kin-search>` results
are buttons that dispatch `kin:open-search-result` with canonical ids only.
`<kin-segment-nav>` renders secondary destinations as hash links;
`<kin-sync-status>` renders the header chip from states the app knows.
`<kin-attachments>` adds a `compact` mode (progress plus a thumbnail strip)
for rows; `full` tiles live in the detail view and under notes. See
[WORKSPACE-UX](WORKSPACE-UX.md).

| Event | Dispatching component | `detail` |
| --- | --- | --- |
| `kin:add-item` | `<kin-compose>` | `{ text, classification, planningDate: number \| null, pinned: boolean, composer }` |
| `kin:open-item` | `<kin-item>` | `{ itemId, opener }` |
| `kin:close-item-detail` | `<kin-item-detail>` | none |
| `kin:open-search-result` | `<kin-search>` | `{ kind: "item" \| "step" \| "handoff" \| "talk" \| "note" \| "reference-record" \| "maintenance", id, itemId?, stepId?, opener }` |

All bubble and are composed; none carries derived business state.

## Component responsibilities

### `<kin-app>`

Own application initialization, WASM loading, IndexedDB opening/loading, orchestration of the storage and Rust bridge, global loading/error states, and passing Rust-derived state to presentation components. It is the only owner of the command-to-event-to-persist flow. It must not duplicate Rust's validation or reducer.

The More page exposes the native household-mode selector and submits explicit
mode-change commands through the same command, replay, and persistence path.
It restores the selected value if local persistence fails.

### `<kin-today>`

Display the selected Today, Needs, Shopping, or Staples classification using the projection supplied by `<kin-app>`. Group active/completed items and omit archived tombstones. Staples remain active reusable entries and expose a manual add-to-Shopping action instead of completion. Do not rank people or add calendar-like features. Each section carries a one-line hint. Since v0.41.0 a Needs, Shopping, or Staples list owns one compact `<kin-compose>` fixed to its own classification, and the list remembers which items have their Details disclosure open across re-renders.

### `<kin-compose>`

Provide a labeled, short item-entry form. The Today page form defaults classification to Today (`default-classification`) and keeps whichever destination the person last chose; a list form sets `fixed-classification` and `scope`, hides the selector, and labels the field "Add to <list>". On valid submission, dispatch `kin:add-item` with the submitted text, classification snapshot, and a `composer` reference so `<kin-app>` clears and refocuses the form that submitted. It does not create event IDs, write storage, or mutate authoritative state.

### `<kin-item>`

Render one item: its text, a short context line (area, planned date, responsibility, last changed), visible photo tiles, and one primary action (Complete/Reopen or Add to Shopping). Checklist and `Details` are secondary disclosures; Details holds the file control, responsibility, area, planned date, reminder, pin, and archive controls and dispatches `kin:toggle-item-tools` (handled by `<kin-today>`). It does not decide or persist transitions.

### `<kin-attachments>`

Render attachment tiles for one parent record. `mode` is `full` (an "Add a photo or file" button plus tiles; notes, references, maintenance) or `tiles` (saved files and capture progress; the item's main area, where `<kin-item>` renders its own visible `Add photo` button). The component owns no file input: a tap on either button dispatches `kin:pick-attachment`, and `<kin-app>` opens its single hidden file input synchronously inside that tap, so a list refresh while the native picker is open cannot detach the control that receives the file. Capture progress ("Preparing photo…", "Saving securely…", saved, or a specific error) is read from `web/attachments/attachment-progress.js` on every render so it survives re-rendering. Image tiles request a bounded preview from the `previews` provider only when the tile intersects the viewport and dispatch `kin:view-attachment`; document tiles show kind, size, status, Open and Save. The component never stores decrypted bytes; `<kin-app>` owns the session preview cache and the viewer dialog and revokes every object URL on lock.

### `<kin-routines>`

Keep routine definitions visible during Vacation, Guests, or Rest and explain
that occurrences are paused. Hide occurrence complete/reopen actions while
paused; the Rust command validator independently rejects those mutations.
Routine archival remains available.

Only create the components needed for these responsibilities; do not componentize for its own sake. A simpler `<kin-app>`-owned view is acceptable if it avoids needless indirection while preserving these boundaries.

## Browser-native command events

| Event               | Dispatching component | `detail`                                 | `bubbles` | `composed` | `cancelable` |
| ------------------- | --------------------- | ---------------------------------------- | --------- | ---------- | ------------ | ------- |
| `kin:add-item`      | `<kin-compose>`       | `{ text: string, classification: "today" | "need" | "shopping" | "staple", composer: KinCompose }` | `true`     | `true`       | `false` |
| `kin:toggle-item-tools` | `<kin-item>`      | `{ itemId: string }` (presentation only; handled by `<kin-today>`) | `true` | `true` | `false` |
| `kin:pick-attachment` | `<kin-item>`, `<kin-attachments>` | `{ parentKind, parentId, label, opener }` (presentation only; `<kin-app>` opens its file input synchronously) | `true` | `true` | `false` |
| `kin:view-attachment` | `<kin-attachments>` | `{ attachmentId, parentKind, parentId, name, opener }` | `true` | `true` | `false` |
| `kin:household-status` | `<kin-household>` | `{ identity: boolean, claimState, memberKind, lifecycle }` (presentation only) | `true` | `true` | `false` |
| `kin:security-changed` | `<kin-security>` | none (passkey wrapper added) | `true` | `true` | `false` |
| `kin:replenish-staple` | `<kin-item>`       | `{ itemId: string }`                     | `true`    | `true`     | `false`      |
| `kin:complete-item` | `<kin-item>`          | `{ itemId: string }`                     | `true`    | `true`     | `false`      |
| `kin:reopen-item`   | `<kin-item>`          | `{ itemId: string }`                     | `true`    | `true`     | `false`      |
| `kin:archive-item`  | `<kin-item>`          | `{ itemId: string }`                     | `true`    | `true`     | `false`      |

`composed: true` allows a command to cross a shadow boundary to `<kin-app>`; `bubbles: true` allows normal ancestor handling. Events represent user intent, not successful domain mutations. `<kin-app>` validates through Rust, persists the accepted event, then rerenders from returned state. Errors are presented through an explicit app state, not by components pretending the action succeeded.

The detail value contains only the minimum command data. Do not include member analytics, device telemetry, or derived business state. Use native `CustomEvent`; no event bus dependency is needed.

## State and accessibility boundary

Parent/application orchestration supplies state as properties or a documented attribute/property contract; components do not read IndexedDB or call WASM directly. Controls use semantic HTML, labels, keyboard interaction, visible focus, and accessible status feedback as described in [ACCESSIBILITY](ACCESSIBILITY.md). User text is rendered as text, never interpolated as executable HTML.

## Handoff component

`kin-handoff-list` owns dedicated capture and semantic needs-attention/recent lists. It renders Rust status and hides archived rows; it never validates transitions. Bubbling/composed commands: `kin:add-handoff { text }`, `kin:acknowledge-handoff { handoffId }`, `kin:archive-handoff { handoffId }`. KinApp validates via Rust and persists atomically. Older successful submissions never clear newer text. No classification selector or verified-person attribution appears.

## v0.3.4 retry recovery

User-authorized follow-up patch: a failed canonical refresh retains the original failed command and feedback in transient application memory. Repeated refresh failure offers refresh retry first; successful Rust replay restores the command retry unless canonical state invalidates it. No automatic append occurs on refresh recovery. New commands supersede suspended retries. Browser regressions cover Handoff add/acknowledge/archive, Item add, repeated failure, newer drafts, stale peer actions and supersession. This is not persisted household state or a new capability.

## v0.4.0 Talk

kin-talk-list owns the single labeled input and semantic Open/Resolved lists. Bubbling/composed commands: kin:add-talk { text }, kin:resolve-talk { talkId }, kin:reopen-talk { talkId }, kin:archive-talk { talkId }. KinApp validates through Rust and persists; the component only renders and dispatches intent. See [V0.4.0](V0.4.0.md).

## v0.5.0 Pulse

kin-pulse provides native Current capacity/For selects and Set pulse/Change/Clear buttons. kin:set-pulse {value,hours} and kin:clear-pulse bubble/composed. KinApp freezes SET timestamp/expiry and owns persistence, time refresh and retry. Component renders Rust status only. See [V0.5.0](V0.5.0.md).

## v0.6.0 Since You Last Looked

`kin-catch-up` receives the Rust-derived summary, local `last_looked_at`, and the immutable mapped snapshot boundary. It renders a semantic heading/list, concise browser-owned household wording, omitted count, textual empty state, and an explicit Caught up button. It dispatches `kin:caught-up` without cursor data; KinApp owns transactional marking, busy/focus/feedback, refresh and content-free `view-state-changed` BroadcastChannel invalidation. It does not access IndexedDB or infer actors.

## v0.7.0 Routines

`<kin-routines>` receives canonical `routines` and `disabled` properties. It dispatches bubbling/composed `kin:create-routine`, `kin:complete-routine-occurrence`, `kin:reopen-routine-occurrence`, and `kin:archive-routine` intents. Occurrence intents carry the rendered key. KinApp owns storage, retries, status and lifecycle refresh. The component uses native form/list/button semantics and restores row focus after updates. See [V0.7.0](V0.7.0.md).

## v0.19.0 Shared Shopping Lists

`<kin-compose>` offers Shopping through the same labeled native
classification selector and `kin:add-item` intent. `<kin-app>` constructs a
Shopping-filtered `<kin-today>` on the Lists page and passes the same
Rust-derived Item/Area projection used by Today and Needs. Existing Item
commands and lifecycle focus restoration apply without a new component or
event family. See [V0.19.0](releases/V0.19.0.md).

## v0.20.0 Staples & Replenishment

`<kin-compose>` adds Staples through the same classification selector.
`<kin-app>` renders a Staples-filtered `<kin-today>` on Lists. `<kin-item>`
dispatches `kin:replenish-staple` with only the staple Item ID; the app reads
the canonical staple text and appends a separate Shopping Item, preserving
list focus and leaving the staple active. Archiving the staple does not affect
the Shopping Item. See [V0.20.0](releases/V0.20.0.md).

## v0.22.0 Lightweight Planning Dates

`<kin-item>` exposes a native, accessible date input and Today/Tomorrow/Clear
controls for existing non-archived Items. The browser resolves shortcuts to
fixed local civil dates and dispatches `kin:set-item-planning-date`; `<kin-app>`
persists that intent through the same event-store transaction as other Item
changes. Archived Items are read-only. See
[V0.22.0](releases/V0.22.0.md).

## v0.23.0 Calendar Interoperability

`<kin-app>` enables a Lists-page download only when an active dated Item
exists. It serializes the existing Rust-derived Item projection into a
bounded, local iCalendar all-day export, then uses a browser Blob download.
No event is appended and no calendar service is contacted. The UI discloses
that the downloaded file contains plaintext Item text. See
[V0.23.0](releases/V0.23.0.md).

## v0.24.0 Useful Household History

`<kin-item>` renders the Rust-derived `lastChangedAt` as a localized,
date-only “Last changed” text label. It receives no actor/device identity and
does not expose a read receipt, exact time, or timeline. It adds no command or
event. See [V0.24.0](releases/V0.24.0.md).

## Bulk actions

`<kin-today>` (To do and Shopping only) owns selection mode, the selected ids,
the toolbar, and the outcome area. These are persistent nodes, so focus
survives list re-renders. `<kin-item>` renders a native checkbox when
`selectable` is set and dispatches `kin:item-selection`. The list dispatches
`kin:bulk-item-action`, `kin:bulk-undo`, `kin:bulk-retry`, and
`kin:bulk-dismiss`. `<kin-app>` plans with `web/bulk-actions.js`, appends the
existing commands one at a time, and keeps the undo and retry sets in memory
under the current session generation. See [WORKSPACE-UX](WORKSPACE-UX.md)
§5.4.

## Repeating tasks

`<kin-quick-add>` adds a collapsed Repeat disclosure for task destinations and
passes `cadence` with `kin:add-item`; `<kin-app>` then appends one
`create-routine` command keyed by the capture's client id. `<kin-today>`
renders each Routine's Rust `nextOn` and a Schedule button that dispatches
`kin:open-routine-schedule`. `<kin-routines>` owns a per-row Schedule editor
that dispatches `kin:change-routine-schedule`; the row's Stop repeating button
dispatches `kin:archive-routine`. The open row and unsaved choice survive
re-renders. `<kin-app>` plans schedule
changes with `web/recurrence.js` and keeps the replacement id until the change
finishes. See [WORKSPACE-UX](WORKSPACE-UX.md) §5.5.

## Keyboard shortcuts and command palette

`<kin-command-palette>` owns two native modal dialogs: the command palette,
an APG combobox over a listbox, and the keyboard shortcut help. Both live in
light DOM and are styled by `app.css`, like `<kin-quick-add>`. Choosing a
command only reports an allowlisted id (`onCommand`). `<kin-app>` performs it
through its existing `navigate()`, Search focus, and `quickAdd.open()`
methods. `dismiss()` closes both dialogs without side effects on lock or
disconnection. The pure `web/keyboard-commands.js` module holds the command
allowlist, filtering, key mapping, and typing detection. See
[WORKSPACE-UX](WORKSPACE-UX.md) §5.3.

## v0.25.0 Search & Filters

`<kin-search>` receives the unlocked Item, Handoff, Talk, Note, and Area
projection from `<kin-app>`. It searches unarchived text in memory and renders
up to 100 results with the total count. Classification, status, and Area
filters narrow Item and checklist-Step matches only. Native labeled controls,
keyboard focus retention, and a polite live result count support accessible
use. Search queries and filters are discarded on lock and are not persisted,
exported, or synchronized. See [V0.25.0](releases/V0.25.0.md).
