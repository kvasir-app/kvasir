import { Stack } from 'expo-router';
import { SQLiteProvider } from 'expo-sqlite';
import { StatusBar } from 'expo-status-bar';
import { prepareDatabase } from '../db';

/**
 * Root layout. SQLiteProvider opens the database and runs `onInit` BEFORE
 * rendering any route — so migrations are guaranteed applied at app start
 * (the provider gates children on it). `prepareDatabase` also sets the
 * connection-level PRAGMAs (foreign_keys, WAL); `runMigrations` is idempotent.
 */
export default function RootLayout() {
  return (
    <SQLiteProvider databaseName="kvasir.db" onInit={prepareDatabase}>
      <StatusBar style="light" />
      <Stack>
        <Stack.Screen name="index" options={{ title: 'Kvasir' }} />
      </Stack>
    </SQLiteProvider>
  );
}
