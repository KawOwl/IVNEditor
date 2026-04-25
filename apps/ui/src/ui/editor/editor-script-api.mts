import type { ScriptManifest } from '@ivn/core/types';
import { getBackendUrl } from '@/lib/backend-url';
import type { VersionSummary } from '#internal/ui/editor/VersionHistoryList';

export type AuthHeaders = Record<string, string>;

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiFailure {
  ok: false;
  status: number;
  text: string;
}

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

export interface MineScriptSummary {
  id: string;
  label: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  versionCount: number;
  hasPublished: boolean;
  publishedVersionId: string | null;
  latestDraftVersionId: string | null;
}

export interface ScriptMeta {
  id: string;
  label: string;
  description: string;
  published: boolean;
  productionLlmConfigId?: string | null;
}

export interface ScriptVersionDetail {
  id: string;
  scriptId?: string;
  status: string;
  manifest: ScriptManifest;
  label?: string | null;
}

export interface SaveScriptMetadata {
  label: string;
  description: string;
  productionLlmConfigId: string | null;
}

export interface CreatedScript {
  id: string;
}

export interface CreatedVersion {
  versionId: string;
  created: boolean;
}

function apiUrl(path: string): string {
  return `${getBackendUrl()}${path}`;
}

async function readResult<T>(res: Response): Promise<ApiResult<T>> {
  const text = await res.text();

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      text,
    };
  }

  return {
    ok: true,
    data: (text ? JSON.parse(text) : undefined) as T,
  };
}

export async function listMineScripts(
  authHeader: AuthHeaders,
): Promise<ApiResult<{ scripts: MineScriptSummary[] }>> {
  return readResult(
    await fetch(apiUrl('/api/scripts/mine'), { headers: authHeader }),
  );
}

export async function listScriptVersions(
  scriptId: string,
  authHeader: AuthHeaders,
): Promise<ApiResult<{ versions: VersionSummary[] }>> {
  return readResult(
    await fetch(apiUrl(`/api/scripts/${scriptId}/versions`), { headers: authHeader }),
  );
}

export async function getScriptVersion(
  versionId: string,
  authHeader: AuthHeaders,
): Promise<ApiResult<ScriptVersionDetail>> {
  return readResult(
    await fetch(apiUrl(`/api/script-versions/${versionId}`), { headers: authHeader }),
  );
}

export async function getScriptMeta(
  scriptId: string,
  authHeader: AuthHeaders,
): Promise<ApiResult<ScriptMeta>> {
  return readResult(
    await fetch(apiUrl(`/api/scripts/${scriptId}/full`), { headers: authHeader }),
  );
}

export async function createScript(
  metadata: SaveScriptMetadata,
  authHeader: AuthHeaders,
): Promise<ApiResult<CreatedScript>> {
  return readResult(
    await fetch(apiUrl('/api/scripts'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify(metadata),
    }),
  );
}

export async function updateScriptMetadata(
  scriptId: string,
  metadata: SaveScriptMetadata,
  authHeader: AuthHeaders,
): Promise<ApiResult<unknown>> {
  return readResult(
    await fetch(apiUrl(`/api/scripts/${scriptId}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify(metadata),
    }),
  );
}

export async function renameScript(
  scriptId: string,
  label: string,
  authHeader: AuthHeaders,
): Promise<ApiResult<unknown>> {
  return readResult(
    await fetch(apiUrl(`/api/scripts/${scriptId}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify({ label }),
    }),
  );
}

export async function createScriptVersion(
  scriptId: string,
  manifest: ScriptManifest,
  authHeader: AuthHeaders,
): Promise<ApiResult<CreatedVersion>> {
  return readResult(
    await fetch(apiUrl(`/api/scripts/${scriptId}/versions`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify({ manifest }),
    }),
  );
}

export async function deleteScript(
  scriptId: string,
  authHeader: AuthHeaders,
): Promise<ApiResult<unknown>> {
  return readResult(
    await fetch(apiUrl(`/api/scripts/${scriptId}`), {
      method: 'DELETE',
      headers: authHeader,
    }),
  );
}

export async function publishScriptVersion(
  versionId: string,
  authHeader: AuthHeaders,
): Promise<ApiResult<unknown>> {
  return readResult(
    await fetch(apiUrl(`/api/script-versions/${versionId}/publish`), {
      method: 'POST',
      headers: authHeader,
    }),
  );
}
