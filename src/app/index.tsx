import { StyleSheet, Text, View } from 'react-native';
import { useSQLiteContext } from 'expo-sqlite';

/**
 * Home screen (first route). Verifies the data layer end-to-end:
 * the DB is open, migrations applied, and the schema is queryable.
 */
export default function Home() {
  const db = useSQLiteContext();

  const applied = db.getAllSync<{ version: number }>(
    'SELECT version FROM migrations ORDER BY version',
  );

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Kvasir</Text>
      <Text style={styles.text}>Learn, don't scroll.</Text>
      <Text style={styles.meta}>
        DB ready · migrations applied: {applied.map((m) => m.version).join(', ')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0b1226',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  title: {
    color: '#fbbf24',
    fontSize: 32,
    fontWeight: 'bold',
  },
  text: {
    color: '#e2e8f0',
    fontSize: 16,
  },
  meta: {
    color: '#64748b',
    fontSize: 12,
  },
});
