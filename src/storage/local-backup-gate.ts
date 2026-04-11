/**
 * Local Backup Gate — IndexedDB 下线前的安全网
 *
 * 6.6 把剧本存储彻底迁到后端，IndexedDB 不再使用。但过渡期间编剧浏览器
 * 里可能还有老的本地剧本，直接删库会丢数据。这个模块提供三个原子操作：
 *
 *   1. scanLocalScripts()   — 扫描 IDB，返回里面的 scripts（若 DB 不存在返回 []）
 *   2. downloadLocalBackup() — 打包成单个 JSON 文件触发浏览器下载
 *   3. deleteLocalDatabase() — 删除整个 novel-engine 数据库
 *
 * UI 层（LocalBackupGate.tsx）把这三步串成阻塞式 modal：
 *   checking → needs-backup → backed-up → (delete + reload) → clean
 *
 * 独立于已删除的 scriptStorage，直接用 idb 裸接口打开只读连接，
 * 避免和 ScriptStorage 类的生命周期耦合。
 */

import { openDB } from 'idb';

const DB_NAME = 'novel-engine';
const SCRIPTS_STORE = 'scripts';

// ============================================================================
// Types
// ============================================================================

/** 扫描出来的本地剧本摘要 */
export interface LocalScriptSummary {
  id: string;
  label: string;
  updatedAt: number;
  /** 原始记录的 JSON 结构（不约束类型，用于整包导出） */
  record: unknown;
}

// ============================================================================
// Scan
// ============================================================================

/**
 * 扫描 IDB 里 novel-engine.scripts store 的所有记录。
 *
 * 返回空数组的三种情况：
 *   - `novel-engine` 数据库根本不存在（全新浏览器或已清理过）
 *   - 数据库存在但 `scripts` store 不存在（理论上不会发生，防御性）
 *   - store 存在但没有数据
 *
 * 这个函数只读，不触发 IDB schema upgrade。
 */
export async function scanLocalScripts(): Promise<LocalScriptSummary[]> {
  // 先检测数据库是否存在。indexedDB.databases() 在所有主流浏览器都可用
  // （Safari 14+ / Chrome / Firefox），但还是做 try/catch 兜底。
  try {
    if (typeof indexedDB === 'undefined') return [];

    // databases() 在某些隐身模式下可能抛错，catch 住继续
    let exists = false;
    try {
      const dbs = await indexedDB.databases();
      exists = dbs.some((d) => d.name === DB_NAME);
    } catch {
      // 不支持 databases() API 就直接尝试 open，失败当作没有
      exists = true;
    }
    if (!exists) return [];

    // 用不带 version 的 open——不触发 upgrade handler，只读当前状态
    const db = await openDB(DB_NAME);
    if (!db.objectStoreNames.contains(SCRIPTS_STORE)) {
      db.close();
      return [];
    }

    const all = (await db.getAll(SCRIPTS_STORE)) as Array<{
      id?: string;
      label?: string;
      updatedAt?: number;
    }>;
    db.close();

    return all
      .filter((r) => !!r?.id)
      .map((r) => ({
        id: r.id as string,
        label: r.label ?? '(无标题)',
        updatedAt: r.updatedAt ?? 0,
        record: r,
      }));
  } catch (err) {
    console.warn('[LocalBackupGate] scan failed, treating as empty:', err);
    return [];
  }
}

// ============================================================================
// Backup download
// ============================================================================

/**
 * 把扫描到的所有本地剧本打包成一个 JSON 文件并触发浏览器下载。
 * 文件名格式：`ivn-local-backup-YYYY-MM-DD.json`
 *
 * 格式故意和 script-archive.ts 的 `ivn-archive-v1` 区分开——这里是
 * "批量备份"容器，不是单剧本导出；用户后续要一个个拆出来重新 import。
 */
export function downloadLocalBackup(scripts: LocalScriptSummary[]): void {
  const archive = {
    format: 'ivn-local-backup-v1' as const,
    exportedAt: Date.now(),
    count: scripts.length,
    scripts: scripts.map((s) => s.record),
  };
  const blob = new Blob([JSON.stringify(archive, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ivn-local-backup-${new Date().toISOString().split('T')[0]}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 延迟 revoke，确保下载已经开始
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ============================================================================
// Delete DB
// ============================================================================

/**
 * 删除整个 novel-engine 数据库（包含 scripts + 死代码 saves store）。
 * 如果还有其它 tab 打开着数据库，会 blocked；此时 reject 让 UI 提示
 * 用户关掉其它 tab 再试。
 */
export async function deleteLocalDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      resolve();
      return;
    }
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error('Unknown IDB delete error'));
    req.onblocked = () =>
      reject(
        new Error(
          '删除被阻塞——请关闭其它打开本站的标签页后重试。',
        ),
      );
  });
}
