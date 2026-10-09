# Web Component Contract

**Status:** Current through v0.23.0 Calendar Interoperability; earlier version sections are historical contracts.

## Component responsibilities

### `<kin-app>`

Own application initialization, WASM loading, IndexedDB opening/loading, orchestration of the storage and Rust bridge, global loading/error states, and passing Rust-derived state to presentation components. It is the only owner of the command-to-event-to-persist flow. It must not duplicate Rust's validation or reducer.

The More page exposes the native household-mode selector and submits explicit
mode-change commands through the same command, replay, and persistence path.
It restores the selected value if local persistence fails.

### `<kin-today>`

Display the selected Today, Needs, Shopping, or Staples classification using the projection supplied by `<kin-app>`. Group active/completed items and omit archived tombstones. Staples remain active reusable entries and expose a manual add-to-Shopping action instead of completion. Do not rank people or add calendar-like features.

### `<kin-compose>`

Provide a labeled, short item-entry form that defaults classification to Needs. On valid submission, dispatch `kin:add-item` with the submitted text and classification snapshot. It does not create event IDs, write storage, or mutate authoritative state.

### `<kin-item>`

Render one item and expose semantic complete, reopen, and archive controls as appropriate. Dispatch the corresponding command with the item ID. It does not decide or persist transitions.

### `<kin-routines>`

Keep routine definitions visible during Vacation, Guests, or Rest and explain
that occurrences are paused. Hide occurrence complete/reopen actions while
paused; the Rust command validator independently rejects those mutations.
Routine archival remains available.

Only create the components needed for these responsibilities; do not componentize for its own sake. A simpler `<kin-app>`-owned view is acceptable if it avoids needless indirection while preserving these boundaries.

## Browser-native command events

| Event               | Dispatching component | `detail`                                 | `bubbles` | `composed` | `cancelable` |
| ------------------- | --------------------- | ---------------------------------------- | --------- | ---------- | ------------ | ------- |
| `kin:add-item`      | `<kin-compose>`       | `{ text: string, classification: "today" | "need" | "shopping" | "staple" }` | `true`     | `true`       | `false` |
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
