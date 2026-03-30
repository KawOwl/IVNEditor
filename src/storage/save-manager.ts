/**
 * SaveManager — IndexedDB 存档/读档
 *
 * Step 4.1: 持久化游戏状态到 IndexedDB。
 * 保存内容包括：四层运行时状态 + 当前活跃 segment ID 列表 + 剧本版本号。
 */

import { openDB, type IDBPDatabase } from 'idb';
import type { SaveData, ProgressState, ScriptState, MemoryState, ChangelogEntry } from '../core/types';

// ============================================================================
// Database Schema
// ============================================================================

const DB_NAME = 'novel-engine';
const DB_VERSION = 1;
const SAVES_STORE = 'saves';
const AUTOSAVE_KEY = '__autosave__';

interface SaveRecord {
  id: string;
  label: string;
  timestamp: number;
  scriptId: string;
  scriptVersion: string;
  activeSegmentIds: string[];
  data: SaveData;
}

// ============================================================================
// Database Init
// ============================================================================

async function getDB(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(SAVES_STORE)) {
        const store = db.createObjectStore(SAVES_STORE, { keyPath: 'id' });
        store.createIndex('by-timestamp', 'timestamp');
        store.createIndex('by-script', 'scriptId');
      }
    },
  });
}

// ============================================================================
// SaveManager
// ============================================================================

export class SaveManager {
  private scriptId: string;
  private scriptVersion: string;

  constructor(scriptId: string, scriptVersion: string) {
    this.scriptId = scriptId;
    this.scriptVersion = scriptVersion;
  }

  /** Save game state to a named slot */
  async save(
    slotId: string,
    label: string,
    state: {
      progress: ProgressState;
      scriptState: ScriptState;
      memory: MemoryState;
      changelog: ChangelogEntry[];
    },
    activeSegmentIds: string[],
  ): Promise<void> {
    const db = await getDB();
    const record: SaveRecord = {
      id: `${this.scriptId}:${slotId}`,
      label,
      timestamp: Date.now(),
      scriptId: this.scriptId,
      scriptVersion: this.scriptVersion,
      activeSegmentIds,
      data: {
        version: '2.0.0',
        scriptId: this.scriptId,
        scriptVersion: this.scriptVersion,
        timestamp: Date.now(),
        progress: state.progress,
        scriptState: state.scriptState,
        memory: state.memory,
        changelog: state.changelog,
        activeSegmentIds,
      },
    };
    await db.put(SAVES_STORE, record);
  }

  /** Load game state from a slot */
  async load(slotId: string): Promise<SaveRecord | undefined> {
    const db = await getDB();
    return db.get(SAVES_STORE, `${this.scriptId}:${slotId}`);
  }

  /** Autosave */
  async autosave(
    state: {
      progress: ProgressState;
      scriptState: ScriptState;
      memory: MemoryState;
      changelog: ChangelogEntry[];
    },
    activeSegmentIds: string[],
  ): Promise<void> {
    await this.save(AUTOSAVE_KEY, '自动存档', state, activeSegmentIds);
  }

  /** Load autosave */
  async loadAutosave(): Promise<SaveRecord | undefined> {
    return this.load(AUTOSAVE_KEY);
  }

  /** List all saves for current script */
  async listSaves(): Promise<SaveRecord[]> {
    const db = await getDB();
    const all = await db.getAllFromIndex(SAVES_STORE, 'by-script', this.scriptId);
    return all.sort((a, b) => b.timestamp - a.timestamp);
  }

  /** Delete a save */
  async deleteSave(slotId: string): Promise<void> {
    const db = await getDB();
    await db.delete(SAVES_STORE, `${this.scriptId}:${slotId}`);
  }

  /** Check if a save exists for a slot */
  async hasSave(slotId: string): Promise<boolean> {
    const db = await getDB();
    const record = await db.get(SAVES_STORE, `${this.scriptId}:${slotId}`);
    return !!record;
  }

  /** Get the script version from a save (for version mismatch detection) */
  async getSaveScriptVersion(slotId: string): Promise<string | undefined> {
    const record = await this.load(slotId);
    return record?.scriptVersion;
  }
}
