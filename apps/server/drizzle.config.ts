import { defineConfig } from 'drizzle-kit';
import { getServerEnv } from './src/env';

const env = getServerEnv();

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: env.DATABASE_URL,
  },
});
