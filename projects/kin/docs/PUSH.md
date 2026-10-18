# Push notifications

**Shipped in:** v1.1.0 (#85). Off by default; each device turns it on itself.

A push tells a device that something is new in its household. It never says
what, who added it or how many, and Kin records nothing about whether it was
delivered, shown or tapped (no read receipts; [PRODUCT-BOUNDARIES](PRODUCT-BOUNDARIES.md)).

## What a member sees

People & devices → **Notifications on this device**:

| State | Copy |
| --- | --- |
| Browser without Push API | "This browser can't show Kin notifications." |
| iPhone/iPad in a browser tab | "Add Kin to your Home Screen to get notifications. On iPhone and iPad, only the Home Screen app can receive them." |
| Blocked in browser settings | "Notifications are blocked for Kin in this browser's settings. Allow notifications for this site there, then come back to turn them on." |
| Off | "Off." and **Turn on notifications** |
| On | "On.", **Mute** (1 hour, 8 hours, until I turn them back on) and **Turn off notifications** |
| Muted | "Muted until <local date and time>." (or "until you turn them back on") and **Unmute** |

The section explains once: "Notifications say only that something is new.
They never include what it is or who added it, and Kin doesn't record whether
you saw them." The browser's permission prompt appears only after **Turn on**
is pressed. A mute is stored as an absolute time (no time zone is collected);
"until I turn them back on" is a one-year mute, the service's limit.

The notification reads "Something new in Kin", or "Something new in <name>"
when the household published a home-screen name ([#78](HOUSEHOLD-IDENTITY-DEFAULTS.md#published-install-identity)).
Tapping it focuses an open Kin window or opens Kin; a locked Kin stays locked.

| Platform | Support |
| --- | --- |
| Chrome, Edge, Firefox (computer and Android) | Yes |
| iPhone and iPad (iOS 16.4+) | Only Kin added to the Home Screen |

## How it works

- **Subscriptions.** `PUT /api/push/subscription` stores one subscription per
  device (`push_subscriptions`, server schema 11): the endpoint, the
  browser's P-256 key and auth secret, an optional mute time. `DELETE` removes
  it; `PUT /api/push/mute` sets or clears the mute (at most a year ahead). Each
  call needs a session on a trusted device of an active member, and a device
  manages only its own row.
- **Who is notified.** After a sync batch with new events commits, every
  subscribed, unmuted, still-trusted device of the household's *other*
  members. The author's own devices never are. A household pending deletion
  gets nothing.
- **Calm.** At most one push per device per two minutes. Changes inside the
  window send one more push when it ends, so the last change isn't lost. The
  push `Topic` (per household) lets a push service replace an undelivered
  notification, and the notification `tag` replaces a shown one.
- **Never in the way.** Sending happens after the response, at most four at a
  time, with a 10-second timeout. 429 and 5xx are retried twice (after 5 and
  30 seconds) and then dropped. 404 and 410 delete the subscription.
- **Sender, no dependencies** (`server/web-push.mjs`). VAPID (RFC 8292): an
  ES256 JWT for the endpoint's origin, at most 12 hours, with the deployment's
  origin (or `KIN_PUSH_SUBJECT`) as `sub`. Payload encryption (RFC 8291,
  `aes128gcm`): one record, checked against the RFC's Appendix A vector byte
  for byte ([TEST-VECTORS](TEST-VECTORS.md#push-payload-rfc-8291)). The payload
  is always `{"v":1,"kind":"new"}`.
- **Only real push services.** Endpoints must be `https` on port 443 at
  `fcm.googleapis.com`, `*.push.services.mozilla.com`, `*.push.apple.com` or
  `*.notify.windows.com`. IP literals, other ports and credentials are
  refused, so a subscription can't aim the service at another network.
- **VAPID keys** are created on first use and kept in SQLite
  (`push_vapid_keys`), not a file: the sandboxed service can't fsync files
  ([DEVELOPMENT](DEVELOPMENT.md#the-service-sandbox)), and SQLite makes the key
  durable and part of every backup. No key or endpoint is logged.
- **Lifecycle.** Revoking a device, removing a member, a Temporary member's
  expiry and leaving the household delete the affected subscriptions in the
  same transaction (the sync service's access-change hook). Household
  deletion purges them. Sending re-checks trust, so nothing reaches a device
  that lost access in between.
- **Service worker.** `push` always shows the notification (browsers require
  one), reading only the manifest for the household's name and icon; it never
  opens key stores or decrypts. `notificationclick` focuses or opens Kin.
  `pushsubscriptionchange` re-subscribes with the same key and saves it. Push
  handling writes no caches.

## Not included

- Reminder notifications while Kin is closed: they would need reminder times
  on the server, a separate privacy decision.
- Per-category notifications (handoffs vs lists): they would tell the service
  what kind of event each one is.
