/**
 * IndexedDB implementation of IScriptStorage using the `idb` library.
 */

import { openDB, type IDBPDatabase, type DBSchema } from 'idb';
import type { IScriptStorage, ScriptBundle, ScriptMetadata } from './storage-interface';

interface NovelDB extends DBSchema {
  scripts: {
    key: string;
    value: ScriptBundle;
    indexes: {
      'by-updated': number;
    };
  };
}

const DB_NAME = 'novel-engine-db';
const DB_VERSION = 1;

export class IDBScriptStorage implements IScriptStorage {
  private db: IDBPDatabase<NovelDB> | null = null;

  async init(): Promise<void> {
    this.db = await openDB<NovelDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const store = db.createObjectStore('scripts', {
          keyPath: 'metadata.id',
        });
        store.createIndex('by-updated', 'metadata.updatedAt');
      },
    });
  }

  private getDB(): IDBPDatabase<NovelDB> {
    if (!this.db) throw new Error('Storage not initialized. Call init() first.');
    return this.db;
  }

  async listScripts(): Promise<ScriptMetadata[]> {
    const db = this.getDB();
    const all = await db.getAllFromIndex('scripts', 'by-updated');
    // Return metadata only, sorted newest first
    return all.map((s) => s.metadata).reverse();
  }

  async getScript(id: string): Promise<ScriptBundle | null> {
    const db = this.getDB();
    return (await db.get('scripts', id)) ?? null;
  }

  async saveScript(script: ScriptBundle): Promise<void> {
    const db = this.getDB();
    await db.put('scripts', script);
  }

  async deleteScript(id: string): Promise<void> {
    const db = this.getDB();
    await db.delete('scripts', id);
  }

  async hasScript(id: string): Promise<boolean> {
    const db = this.getDB();
    const key = await db.getKey('scripts', id);
    return key !== undefined;
  }
}
