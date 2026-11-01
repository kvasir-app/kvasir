// Node module-resolution hooks for running the TypeScript db layer (and the
// seed CLI) directly with `node --experimental-strip-types`:
//  1. 'expo-crypto' → 'node:crypto': expo-crypto's JS entry pulls the native
//     module via expo's requireNativeModule, which cannot load under plain
//     Node. The app only uses randomUUID(), which node:crypto provides with
//     identical semantics (the vitest alias in vitest.config.ts points at the
//     equivalent tests/mocks/expo-crypto.ts).
//  2. Extensionless relative imports ('./decksRepo') → '.ts': the db layer is
//     written Expo/Metro-style (extensionless), Node's ESM resolver needs the
//     explicit extension.
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'expo-crypto') {
      return nextResolve('node:crypto', context);
    }
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        context.parentURL &&
        (specifier.startsWith('./') || specifier.startsWith('../'))
      ) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});
