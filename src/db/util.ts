/**
 * Small shared helpers for the repos.
 */
import { randomUUID } from 'expo-crypto';

/**
 * Client-generated UUIDv4 (TEXT PKs — sync prep, no autoincrement).
 * expo-crypto's randomUUID is backed by the native crypto module on device
 * and by Node's crypto in tests.
 */
export function generateId(): string {
  return randomUUID();
}

/** ISO-8601 UTC timestamp, the app-wide timestamp convention. */
export function nowIso(): string {
  return new Date().toISOString();
}
