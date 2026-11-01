import { Stack } from 'expo-router';
import { SQLiteProvider, type SQLiteDatabase } from 'expo-sqlite';
import { StatusBar } from 'expo-status-bar';
import { runMigrations } from '../db';

/**
 * Root layout. SQLiteProvider opens the database and runs `onInit` BEFORE
 * rendering any route — so migrations are guaranteed applied at app start
 * (the provider gates children on it). `runMigrations` is idempotent.
 */
export default function RootLayout() {
  return (
    <SQLiteProvider databaseName="kvasir.db" onInit={migrateDatabase}>
      <StatusBar style="light" />
      <Stack>
        <Stack.Screen name="index" options={{ title: 'Kvasir' }} />
      </Stack>
    </SQLiteProvider>
  );
}

async function migrateDatabase(db: SQLiteDatabase): Promise<void> {
  await runMigrations(db);
}
