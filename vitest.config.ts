import path from 'node:path';
import { defineConfig } from 'vitest/config';

const rootDir = path.resolve(__dirname);

export default defineConfig({
  resolve: {
    alias: [
      {
        // Tests run on plain Node: 'expo-crypto' would pull the native module
        // (requireNativeModule). Alias it to a test double with the same
        // surface (randomUUID backed by node:crypto — Expo's own mock returns
        // undefined, which broke every repo INSERT).
        find: /^expo-crypto$/,
        replacement: path.join(rootDir, 'tests/mocks/expo-crypto.ts'),
      },
    ],
  },
  test: {
    environment: 'node',
  },
});
