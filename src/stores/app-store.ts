/**
 * AppStore — 应用级路由 + 脚本目录状态
 *
 * 用 Zustand 状态路由管理页面切换，不引入 React Router。
 */

import { create } from 'zustand';
import type { ScriptCatalogEntry } from '../core/types';

// ============================================================================
// Types
// ============================================================================

export type AppPage =
  | { name: 'home' }
  | { name: 'play'; scriptId: string }
  | { name: 'editor'; scriptId?: string };

export interface AppState {
  page: AppPage;
  catalog: ScriptCatalogEntry[];

  // actions
  navigateTo: (page: AppPage) => void;
  goHome: () => void;
  setCatalog: (entries: ScriptCatalogEntry[]) => void;
}

// ============================================================================
// Store
// ============================================================================

export const useAppStore = create<AppState>((set) => ({
  page: { name: 'home' },
  catalog: [],

  navigateTo: (page) => set({ page }),

  goHome: () => set({ page: { name: 'home' } }),

  setCatalog: (catalog) => set({ catalog }),
}));
