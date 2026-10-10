// Shared by enrollment and durable validation; historical records do not count
// toward the active-member or non-revoked-device limits.
// Kin remains a deliberately small household. Historical inactive members do
// not consume this admission bound.
export const MAX_ACTIVE_MEMBERS = 4;
export const MAX_TRUSTED_DEVICES = 16;
