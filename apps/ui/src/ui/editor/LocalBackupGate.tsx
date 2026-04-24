/**
 * LocalBackupGate — IndexedDB 下线前的阻塞式备份 Gate
 *
 * 包在 EditorPage 外层，在渲染真正的编辑器 UI 之前先扫一次 IDB：
 *   - 没有遗留数据 → 直接 render children（只有一次极短闪烁）
 *   - 有遗留数据  → 阻塞显示 modal，分两步：
 *       1. needs-backup：列出本地剧本 + [下载备份]
 *       2. backed-up：确认提示 + [清理本地缓存] → deleteDatabase → reload
 *
 * 不提供"跳过"按钮——这是用户决策，强制走完备份流程再进入编辑器。
 *
 * 这个组件是 6.6 过渡期的临时产物。等所有活跃编剧都走过一次后，
 * 整个文件 + local-backup-gate.ts + idb 依赖一起在 follow-up PR 删掉。
 */

import { useEffect, useState, useCallback } from 'react';
import {
  scanLocalScripts,
  downloadLocalBackup,
  deleteLocalDatabase,
  type LocalScriptSummary,
} from '@/storage/local-backup-gate';

type GateState = 'checking' | 'needs-backup' | 'backed-up' | 'clean' | 'error';

export function LocalBackupGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<GateState>('checking');
  const [scripts, setScripts] = useState<LocalScriptSummary[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    scanLocalScripts()
      .then((list) => {
        if (cancelled) return;
        if (list.length === 0) {
          setState('clean');
        } else {
          setScripts(list);
          setState('needs-backup');
        }
      })
      .catch((err) => {
        if (cancelled) return;
        // 扫描异常 → 当作没有本地数据（scanLocalScripts 内部已经 try/catch
        // 过一遍，这里基本不会触发）
        console.warn('[LocalBackupGate] unexpected scan error:', err);
        setState('clean');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleDownload = useCallback(() => {
    try {
      downloadLocalBackup(scripts);
      setState('backed-up');
    } catch (err) {
      setErrorMsg(String(err));
      setState('error');
    }
  }, [scripts]);

  const handleClear = useCallback(async () => {
    try {
      await deleteLocalDatabase();
      // reload 让整个 App 重新 mount，gate 再扫一次会立刻得到 clean
      window.location.reload();
    } catch (err) {
      setErrorMsg(String(err));
      setState('error');
    }
  }, []);

  // clean → 直接透传
  if (state === 'clean') return <>{children}</>;

  // checking → 全屏 loader
  if (state === 'checking') {
    return (
      <div className="h-full bg-zinc-950 text-zinc-100 flex items-center justify-center">
        <p className="text-zinc-500 text-sm">正在检查本地缓存...</p>
      </div>
    );
  }

  // error → 全屏错误
  if (state === 'error') {
    return (
      <div className="h-full bg-zinc-950 text-zinc-100 flex items-center justify-center">
        <div className="max-w-md text-center space-y-3">
          <p className="text-red-400">清理失败</p>
          <p className="text-xs text-zinc-500">{errorMsg}</p>
          <button
            onClick={() => window.location.reload()}
            className="text-sm text-blue-400 hover:text-blue-300"
          >
            重新加载
          </button>
        </div>
      </div>
    );
  }

  // needs-backup / backed-up → 阻塞 modal
  return (
    <div className="h-full bg-zinc-950 text-zinc-100 flex items-center justify-center px-6">
      <div className="max-w-lg w-full bg-zinc-900 border border-zinc-700 rounded-lg p-6 space-y-4 shadow-2xl">
        <h2 className="text-base font-medium text-zinc-100">
          检测到旧版本本地缓存剧本
        </h2>

        <p className="text-xs text-zinc-400 leading-relaxed">
          编辑器已升级为云端单一数据源，不再使用浏览器本地数据库。
          为了确保你不会丢失任何数据，请先下载本地缓存备份文件，
          妥善保存后再清理缓存，之后你可以在编辑器里通过"导入"按钮
          把需要的剧本一个个重新上传到云端。
        </p>

        {/* 本地剧本列表 */}
        <div className="bg-zinc-950/50 border border-zinc-800 rounded p-3 max-h-48 overflow-y-auto space-y-1.5">
          <div className="text-[10px] text-zinc-600 mb-1">
            本地缓存 {scripts.length} 个剧本：
          </div>
          {scripts.map((s) => (
            <div
              key={s.id}
              className="text-xs text-zinc-300 flex items-center justify-between gap-2"
            >
              <span className="truncate">{s.label}</span>
              <span className="text-[10px] text-zinc-600 flex-none">
                {s.updatedAt
                  ? new Date(s.updatedAt).toLocaleDateString()
                  : '—'}
              </span>
            </div>
          ))}
        </div>

        {state === 'needs-backup' && (
          <div className="space-y-2">
            <button
              onClick={handleDownload}
              className="w-full text-sm px-4 py-2 rounded bg-emerald-900/40 border border-emerald-700/60 text-emerald-300 hover:bg-emerald-800/40 transition-colors"
            >
              下载备份文件（ivn-local-backup-*.json）
            </button>
            <p className="text-[10px] text-zinc-600 text-center">
              下载后请务必确认文件已保存到本地磁盘
            </p>
          </div>
        )}

        {state === 'backed-up' && (
          <div className="space-y-3">
            <div className="text-xs text-emerald-400 bg-emerald-950/30 border border-emerald-900/50 rounded px-3 py-2">
              ✓ 备份文件已触发下载，请到浏览器下载目录确认收到文件后再清理。
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setState('needs-backup')}
                className="flex-1 text-xs px-3 py-2 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 transition-colors"
              >
                再下载一次
              </button>
              <button
                onClick={handleClear}
                className="flex-1 text-xs px-3 py-2 rounded bg-red-900/40 border border-red-800/60 text-red-300 hover:bg-red-800/40 transition-colors"
              >
                已保存，清理本地缓存
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
