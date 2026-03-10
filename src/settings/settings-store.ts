/**
 * Settings Store — manages script persistence, selection, and settings UI state.
 */

import { create } from 'zustand';
import type { IScriptStorage, ScriptMetadata, ScriptBundle } from '../storage/storage-interface';
import { ScriptBundleSchema } from '../storage/storage-interface';
import { IDBScriptStorage } from '../storage/idb-storage';
import { createBuiltinScript, BUILTIN_SCRIPT_ID } from '../storage/seed';

export type SettingsTab = 'select' | 'upload' | 'generate' | 'model';

interface SettingsState {
  // Storage service
  storage: IScriptStorage;
  initialized: boolean;

  // Script list
  scripts: ScriptMetadata[];
  activeScriptId: string | null;
  activeScript: ScriptBundle | null;

  // UI state
  currentTab: SettingsTab;
  isLoading: boolean;
  error: string | null;

  // Actions
  initStorage(): Promise<void>;
  refreshScripts(): Promise<void>;
  selectScript(id: string): Promise<void>;
  saveScript(script: ScriptBundle): Promise<void>;
  deleteScript(id: string): Promise<void>;
  setTab(tab: SettingsTab): void;
  setError(error: string | null): void;
  setLoading(loading: boolean): void;
  validateAndSave(rawJson: unknown): Promise<{ ok: boolean; error?: string }>;
}

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  storage: new IDBScriptStorage(),
  initialized: false,
  scripts: [],
  activeScriptId: null,
  activeScript: null,
  currentTab: 'select',
  isLoading: false,
  error: null,

  async initStorage() {
    try {
      const { storage } = get();
      await storage.init();

      // Seed builtin script if not present
      const hasBuiltin = await storage.hasScript(BUILTIN_SCRIPT_ID);
      if (!hasBuiltin) {
        await storage.saveScript(createBuiltinScript());
      }

      set({ initialized: true });
      await get().refreshScripts();

      // Auto-select builtin if no active script
      if (!get().activeScriptId) {
        await get().selectScript(BUILTIN_SCRIPT_ID);
      }
    } catch (err) {
      console.error('Failed to initialize storage:', err);
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  async refreshScripts() {
    const { storage } = get();
    const scripts = await storage.listScripts();
    set({ scripts });
  },

  async selectScript(id: string) {
    const { storage } = get();
    set({ isLoading: true, error: null });
    try {
      const script = await storage.getScript(id);
      if (!script) throw new Error(`剧本 ${id} 未找到`);
      set({ activeScriptId: id, activeScript: script });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ isLoading: false });
    }
  },

  async saveScript(script: ScriptBundle) {
    const { storage } = get();
    await storage.saveScript(script);
    await get().refreshScripts();
  },

  async deleteScript(id: string) {
    if (id === BUILTIN_SCRIPT_ID) return; // Protect builtin
    const { storage } = get();
    await storage.deleteScript(id);
    if (get().activeScriptId === id) {
      set({ activeScriptId: null, activeScript: null });
      await get().selectScript(BUILTIN_SCRIPT_ID);
    }
    await get().refreshScripts();
  },

  setTab(tab) {
    set({ currentTab: tab, error: null });
  },

  setError(error) {
    set({ error });
  },

  setLoading(loading) {
    set({ isLoading: loading });
  },

  async validateAndSave(rawJson: unknown) {
    try {
      const parsed = ScriptBundleSchema.parse(rawJson);
      // Ensure unique ID and timestamps
      if (!parsed.metadata.id) {
        parsed.metadata.id = `script-${Date.now()}`;
      }
      if (!parsed.metadata.createdAt) {
        parsed.metadata.createdAt = Date.now();
      }
      parsed.metadata.updatedAt = Date.now();
      await get().saveScript(parsed);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `校验失败: ${message}` };
    }
  },
}));
