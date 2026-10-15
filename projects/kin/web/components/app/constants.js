// Shared messages and preferences for the application shell.
export const START_ERROR =
  "Kin could not start its household engine or local storage. Your saved information was not intentionally deleted.";
export const SAVE_ERROR =
  "Kin could not save that change locally. Your existing information was not intentionally deleted.";
export const ATTACHMENT_OPEN_ERROR =
  "We couldn't open this attachment. Your existing household information hasn't been deleted.";
export const AUTO_LOCK_KEY = "kin.auto-lock-minutes";
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
