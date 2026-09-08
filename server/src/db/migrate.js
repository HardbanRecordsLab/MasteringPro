import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import { getDb, dbEnabled } from './index.js';

/** Apply pending migrations. Safe to call on every boot. */
export async function runMigrations() {
  if (!dbEnabled()) {
    console.log('   DB          : disabled (no DATABASE_URL) — AI proxy only');
    return;
  }
  const folder = fileURLToPath(new URL('../../drizzle', import.meta.url));
  await migrate(getDb(), { migrationsFolder: folder });
  console.log('   DB          : migrations up to date');
}

// `node src/db/migrate.js` — run standalone (e.g. one-shot job)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
