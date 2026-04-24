import { defineConfig } from 'drizzle-kit';
import { getServerEnv } from '#internal/env';

const env = getServerEnv();

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: env.DATABASE_URL,
  },
});
