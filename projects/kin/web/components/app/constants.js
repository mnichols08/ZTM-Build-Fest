// Shared messages and preferences for the application shell.
export const START_ERROR =
  "Kin could not start its household engine or local storage. Your saved information was not intentionally deleted.";
export const SAVE_ERROR =
  "Kin could not save that change locally. Your existing information was not intentionally deleted.";
export const ATTACHMENT_OPEN_ERROR =
  "We couldn't open this attachment. Your existing household information hasn't been deleted.";
export const AUTO_LOCK_KEY = "kin.auto-lock-minutes";
// One plain-language line under each destination's heading (#261, #266), so
// a new member learns what lives where without learning Kin's vocabulary
// first. The five destinations keep their names, order and routes; Today's
// line is its date.
export const DESTINATION_DESCRIPTIONS = Object.freeze({
  lists: "Things to do, your shopping list, and staples you buy again and again.",
  routines: "Things that come round again, like bins night, plus checklists you reuse.",
  updates: "Handoffs pass something on to a person, Talk saves a topic for a calm moment, and Chat is for quick back-and-forth.",
  // When the household's chat policy leaves this member without Chat (#123).
  updatesWithoutChat: "Handoffs pass something on to a person, and Talk saves a topic for a calm moment.",
  household: "Notes, areas, people and devices, privacy and recovery, and how Kin looks for your household.",
});
export const INLINE_SAVE_FAILED = "Couldn't save. Your text is still here.";

// Plain-language explanations for sync pauses. The code is kept on the state
// object for debugging and tests; only the wording changes here.
export const SYNC_PAUSE_MESSAGES = {
  device_not_trusted: "This device no longer has access to household updates. Everything already saved here stays on this device.",
  membership_removed: "This device no longer has access to household updates. Everything already saved here stays on this device.",
  authentication_required: "Sign in to your household again to keep syncing. Your changes are saved on this device until then.",
  connection_unavailable: "Your changes are saved on this device and will sync when you're connected.",
};

export function readAutoLockPreference() {
  try {
    const value = Number(localStorage.getItem(AUTO_LOCK_KEY));
    return [0, 5, 15, 60].includes(value) ? value : 0;
  } catch { return 0; }
}

export const BULK_UNDO_WINDOW_MS = 10 * 60_000;
export const BULK_UNDO_UNVERIFIED = "Unable to verify the latest item state. No changes were undone. Try again.";
