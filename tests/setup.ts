/** Load .env for tests. Node 22 can do this without a dependency. */
import { existsSync } from 'node:fs';

if (!process.env.DATABASE_URL && existsSync('.env')) {
  process.loadEnvFile('.env');
}

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is not set. Integration tests need a Postgres database — copy .env.example to .env.',
  );
}
