/**
 * Test double for expo-crypto (aliased in vitest.config.ts).
 *
 * Why not node:crypto directly: the vitest alias must point at a FILE
 * (node: built-ins cannot be aliased), so this module re-exports Node's
 * crypto.randomUUID() under the same surface the app code uses.
 *
 * Why not expo-crypto's own mock (node_modules/expo-crypto/mocks/
 * ExpoCrypto.ts): its randomUUID() is a stub returning undefined, which
 * made every repo INSERT fail with "Provided value cannot be bound to
 * SQLite parameter 1" (generateId() → undefined → NULL PK).
 */
import { randomUUID as nodeRandomUUID } from 'node:crypto';

export function randomUUID(): string {
  return nodeRandomUUID();
}
