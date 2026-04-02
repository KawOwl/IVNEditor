/**
 * ScriptStore — 后端剧本存储
 *
 * 初期使用内存 Map + JSON 文件持久化。
 * 未来可替换为 SQLite / PostgreSQL。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { ScriptManifest } from '../../../src/core/types';

// ============================================================================
// Types (mirrors frontend ScriptRecord)
// ============================================================================

export interface ScriptRecord {
  id: string;
  label: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  published: boolean;
  manifest: ScriptManifest;
}

export interface ScriptCatalogEntry {
  id: string;
  label: string;
  description?: string;
  tags?: string[];
  version?: string;
  chapterCount: number;
}

// ============================================================================
// Storage
// ============================================================================

const DATA_DIR = join(import.meta.dir, '../../data');
const SCRIPTS_FILE = join(DATA_DIR, 'scripts.json');

class ScriptStore {
  private scripts: Map<string, ScriptRecord> = new Map();

  constructor() {
    this.loadFromDisk();
  }

  /** List all published scripts (catalog) */
  listPublished(): ScriptCatalogEntry[] {
    return Array.from(this.scripts.values())
      .filter((r) => r.published)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((r) => ({
        id: r.id,
        label: r.label,
        description: r.description,
        tags: r.manifest.tags,
        version: r.manifest.version,
        chapterCount: r.manifest.chapters.length,
      }));
  }

  /** Get a script by ID */
  get(id: string): ScriptRecord | undefined {
    return this.scripts.get(id);
  }

  /** Publish (create or update) a script */
  publish(record: ScriptRecord): void {
    record.published = true;
    record.updatedAt = Date.now();
    this.scripts.set(record.id, record);
    this.saveToDisk();
  }

  /** Delete a script */
  delete(id: string): boolean {
    const deleted = this.scripts.delete(id);
    if (deleted) this.saveToDisk();
    return deleted;
  }

  // --- Persistence ---

  private loadFromDisk(): void {
    try {
      if (existsSync(SCRIPTS_FILE)) {
        const raw = readFileSync(SCRIPTS_FILE, 'utf-8');
        const records: ScriptRecord[] = JSON.parse(raw);
        for (const r of records) {
          this.scripts.set(r.id, r);
        }
        console.log(`Loaded ${records.length} scripts from disk`);
      }
    } catch (err) {
      console.error('Failed to load scripts:', err);
    }
  }

  private saveToDisk(): void {
    try {
      if (!existsSync(DATA_DIR)) {
        mkdirSync(DATA_DIR, { recursive: true });
      }
      const records = Array.from(this.scripts.values());
      writeFileSync(SCRIPTS_FILE, JSON.stringify(records, null, 2));
    } catch (err) {
      console.error('Failed to save scripts:', err);
    }
  }
}

export const scriptStore = new ScriptStore();
