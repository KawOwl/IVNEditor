/**
 * ScriptStorage — 剧本持久化（IndexedDB）
 *
 * 存储完整的 ScriptManifest，支持 CRUD + 导入导出。
 * 一个剧本 = 一条 ScriptRecord（metadata + manifest）。
 */

import { openDB, type IDBPDatabase } from 'idb';
import type { ScriptManifest } from '../core/types';

// ============================================================================
// Types
// ============================================================================

export interface ScriptRecord {
  id: string;
  label: string;
  description: string;
  updatedAt: number;
  createdAt: number;
  published?: boolean;          // true = 可在首页展示并游玩
  manifest: ScriptManifest;
}

export interface ScriptListItem {
  id: string;
  label: string;
  description: string;
  updatedAt: number;
  fileCount: number;
  published?: boolean;
}

// ============================================================================
// Database
// ============================================================================

const DB_NAME = 'novel-engine';
const DB_VERSION = 2; // bump from 1 (saves store) to add scripts store
const SCRIPTS_STORE = 'scripts';

async function getDB(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      // Existing saves store
      if (!db.objectStoreNames.contains('saves')) {
        const saves = db.createObjectStore('saves', { keyPath: 'id' });
        saves.createIndex('by-timestamp', 'timestamp');
        saves.createIndex('by-script', 'scriptId');
      }
      // New scripts store
      if (!db.objectStoreNames.contains(SCRIPTS_STORE)) {
        const store = db.createObjectStore(SCRIPTS_STORE, { keyPath: 'id' });
        store.createIndex('by-updated', 'updatedAt');
      }
    },
  });
}

// ============================================================================
// ScriptStorage
// ============================================================================

export class ScriptStorage {
  /** List all scripts (lightweight, no manifest content) */
  async list(): Promise<ScriptListItem[]> {
    const db = await getDB();
    const records: ScriptRecord[] = await db.getAll(SCRIPTS_STORE);
    return records
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((r) => ({
        id: r.id,
        label: r.label,
        description: r.description,
        updatedAt: r.updatedAt,
        fileCount: r.manifest.chapters.reduce((sum, ch) => sum + ch.segments.length, 0),
        published: r.published,
      }));
  }

  /** List only published scripts (for home page / player) */
  async listPublished(): Promise<ScriptListItem[]> {
    const all = await this.list();
    return all.filter((r) => r.published);
  }

  /** Mark a script as published */
  async publish(id: string): Promise<void> {
    const db = await getDB();
    const record: ScriptRecord | undefined = await db.get(SCRIPTS_STORE, id);
    if (!record) throw new Error(`Script not found: ${id}`);
    record.published = true;
    record.updatedAt = Date.now();
    await db.put(SCRIPTS_STORE, record);
  }

  /** Mark a script as unpublished */
  async unpublish(id: string): Promise<void> {
    const db = await getDB();
    const record: ScriptRecord | undefined = await db.get(SCRIPTS_STORE, id);
    if (!record) throw new Error(`Script not found: ${id}`);
    record.published = false;
    record.updatedAt = Date.now();
    await db.put(SCRIPTS_STORE, record);
  }

  /** Get a script by ID */
  async get(id: string): Promise<ScriptRecord | undefined> {
    const db = await getDB();
    return db.get(SCRIPTS_STORE, id);
  }

  /** Save (create or update) a script */
  async save(record: ScriptRecord): Promise<void> {
    const db = await getDB();
    await db.put(SCRIPTS_STORE, record);
  }

  /** Rename a script */
  async rename(id: string, newLabel: string): Promise<void> {
    const db = await getDB();
    const record: ScriptRecord | undefined = await db.get(SCRIPTS_STORE, id);
    if (!record) throw new Error(`Script not found: ${id}`);
    record.label = newLabel;
    record.manifest.label = newLabel;
    record.updatedAt = Date.now();
    await db.put(SCRIPTS_STORE, record);
  }

  /** Delete a script */
  async delete(id: string): Promise<void> {
    const db = await getDB();
    await db.delete(SCRIPTS_STORE, id);
  }

  /** Check if a script exists */
  async has(id: string): Promise<boolean> {
    const db = await getDB();
    const record = await db.get(SCRIPTS_STORE, id);
    return !!record;
  }
}

// ============================================================================
// Export / Import helpers
// ============================================================================

/** Export format: single JSON file */
export interface ScriptArchive {
  format: 'ivn-archive-v1';
  exportedAt: number;
  script: ScriptRecord;
}

/** Export a script record to downloadable JSON */
export function exportScript(record: ScriptRecord): string {
  const archive: ScriptArchive = {
    format: 'ivn-archive-v1',
    exportedAt: Date.now(),
    script: record,
  };
  return JSON.stringify(archive, null, 2);
}

/** Parse an imported JSON string, returns ScriptRecord or throws */
export function parseImportedScript(json: string): ScriptRecord {
  const data = JSON.parse(json);

  // Support direct ScriptArchive format
  if (data.format === 'ivn-archive-v1' && data.script) {
    const record = data.script as ScriptRecord;
    validateScriptRecord(record);
    return record;
  }

  // Support raw ScriptManifest (backwards compat)
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
