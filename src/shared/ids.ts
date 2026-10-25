import type { SessionId } from './types';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Random URL-safe id (default 8 chars, base36). Used for shape ids. */
export function newId(length = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

/**
 * Session id: time-sortable and URL-safe, e.g. `mh5x3k2a-4f9q2c1z`.
 * The first part is `Date.now()` in base36, so ids sort by creation time.
 */
export function newSessionId(now = Date.now()): SessionId {
  return `${now.toString(36)}-${newId(8)}`;
}
