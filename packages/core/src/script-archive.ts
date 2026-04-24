/**
 * Script Archive — 剧本 JSON 存档格式工具
 *
 * 纯格式化工具，不依赖 IndexedDB 或任何存储层。
 * 用于：
 *   - 编辑器导出 .ivn.json 文件（exportScript）
 *   - 编辑器导入 .ivn.json 文件（parseImportedScript）
 *   - 本地备份 Gate 的数据类型（ScriptRecord 形状）
 *
 * 6.6 之前这些定义住在 src/storage/script-storage.ts；随着 IndexedDB
 * 下线，IDB 封装整个被删，但存档格式本身还要保留，所以单独拎出来。
 */

import type { ScriptManifest } from './types';

// ============================================================================
// Types
// ============================================================================

/** 一个完整的剧本记录（metadata + manifest） */
export interface ScriptRecord {
  id: string;
  label: string;
  description: string;
  updatedAt: number;
  createdAt: number;
  published?: boolean;
  manifest: ScriptManifest;
}

/** 导出格式：外层包一层元信息方便后续扩展 */
export interface ScriptArchive {
  format: 'ivn-archive-v1';
  exportedAt: number;
  script: ScriptRecord;
}

// ============================================================================
// Export / Import
// ============================================================================

/** 将一个 ScriptRecord 序列化为下载用 JSON 字符串 */
export function exportScript(record: ScriptRecord): string {
  const archive: ScriptArchive = {
    format: 'ivn-archive-v1',
    exportedAt: Date.now(),
    script: record,
  };
  return JSON.stringify(archive, null, 2);
}

/**
 * 解析一个导入的 JSON 字符串为 ScriptRecord。
 * 兼容两种格式：
 *   1. ScriptArchive（外层带 format 标记）
 *   2. 裸的 ScriptManifest（向后兼容早期导出的文件）
 * 失败时抛错。
 */
export function parseImportedScript(json: string): ScriptRecord {
  const data = JSON.parse(json);

  // Case 1: 外层 archive 格式
  if (data.format === 'ivn-archive-v1' && data.script) {
    const record = data.script as ScriptRecord;
    validateScriptRecord(record);
    return record;
  }

  // Case 2: 裸 manifest 格式（向后兼容）
  if (data.id && data.chapters && data.stateSchema) {
    const manifest = data as ScriptManifest;
    const record: ScriptRecord = {
      id: manifest.id,
      label: manifest.label,
      description: manifest.description ?? '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      manifest,
    };
    validateScriptRecord(record);
    return record;
  }

  throw new Error('无法识别的剧本格式');
}

function validateScriptRecord(record: ScriptRecord): void {
  if (!record.id) throw new Error('剧本缺少 id');
  if (!record.manifest) throw new Error('剧本缺少 manifest');
  if (!record.manifest.chapters?.length) throw new Error('剧本缺少章节');
  if (!record.manifest.stateSchema) throw new Error('剧本缺少 stateSchema');
  if (!record.manifest.memoryConfig) throw new Error('剧本缺少 memoryConfig');
}
