/**
 * useAssetUpload — 前端上传 VN 资产 hook（M4 Step 4.4）
 *
 * POST multipart/form-data 到 `/api/scripts/:id/assets`。
 * 成功 return assetUrl（形如 `/api/assets/scripts/<sid>/<uuid>.png`），前端直接塞进
 * manifest.characters[].sprites[].assetUrl 或 manifest.backgrounds[].assetUrl。
 *
 * scriptId 为 null 时 upload 会抛错（调用方应该先禁用 UI）——这对应"新建剧本还没
 * 保存过"的场景，没有 scriptId 没法关联资产。
 */

import { useCallback, useState } from 'react';
import { getBackendUrl } from '@/lib/backend-url';
import { useAuthStore } from '../../stores/auth-store';

export interface UseAssetUploadResult {
  upload: (file: File) => Promise<string>;
  uploading: boolean;
  error: string | null;
  clearError: () => void;
}

export function useAssetUpload(
  scriptId: string | null,
  kind: 'sprite' | 'background',
): UseAssetUploadResult {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = useCallback(
    async (file: File): Promise<string> => {
      if (!scriptId) {
        throw new Error('请先保存剧本（需要 scriptId 才能关联资产）');
      }
      setUploading(true);
      setError(null);
      try {
        const form = new FormData();
        form.append('file', file);
        form.append('kind', kind);
        const authHeader = useAuthStore.getState().getAuthHeader();
        const res = await fetch(
          `${getBackendUrl()}/api/scripts/${scriptId}/assets`,
          { method: 'POST', headers: authHeader, body: form },
        );
        if (!res.ok) {
          const msg = await res.text();
          throw new Error(`上传失败 (${res.status}): ${msg.slice(0, 200)}`);
        }
        const data = (await res.json()) as { assetUrl: string };
        return data.assetUrl;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        throw err;
      } finally {
        setUploading(false);
      }
    },
    [scriptId, kind],
  );

  const clearError = useCallback(() => setError(null), []);

  return { upload, uploading, error, clearError };
}
