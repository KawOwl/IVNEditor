import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createServerEnv,
  parseDotenvText,
  type DotenvSource,
  type ServerEnv,
} from '@ivn/specification/env';

let cachedEnv: ServerEnv | null = null;

const serverDotenvPath = fileURLToPath(new URL('../.env', import.meta.url));
const rootDotenvPath = fileURLToPath(new URL('../../../.env', import.meta.url));

function readDotenv(path: string): DotenvSource {
  if (!existsSync(path)) return {};
  return parseDotenvText(readFileSync(path, 'utf8'));
}

function createDefaultSource(): DotenvSource {
  return {
    ...readDotenv(serverDotenvPath),
    ...process.env,
    ...readDotenv(rootDotenvPath),
  };
}

export function getServerEnv(source: DotenvSource = process.env): ServerEnv {
  if (source === process.env && cachedEnv) return cachedEnv;

  const env = createServerEnv(source === process.env ? createDefaultSource() : source);
  if (source === process.env) {
    cachedEnv = env;
  }
  return env;
}

export function resetServerEnvForTesting(): void {
  cachedEnv = null;
}
