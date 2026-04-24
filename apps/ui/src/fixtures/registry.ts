/**
 * Script Registry — 所有可用剧本的注册表
 *
 * 初期从 fixture 硬编码，未来可从 IndexedDB 动态加载。
 * 提供 catalog（轻量目录）和 manifest（完整数据）的查询接口。
 */

import type { ScriptManifest, ScriptCatalogEntry } from '@ivn/core/types';

// ============================================================================
// Registry — 所有注册的 manifest
// ============================================================================

const manifests: ScriptManifest[] = [];

// ============================================================================
// Public API
// ============================================================================

/** 生成首页用的轻量目录条目 */
export function getCatalog(): ScriptCatalogEntry[] {
  return manifests.map((m) => ({
    id: m.id,
    label: m.label,
    coverImage: m.coverImage,
    description: m.description,
    author: m.author,
    tags: m.tags,
    chapterCount: m.chapters.length,
  }));
}

/** 根据 ID 获取完整 manifest */
export function getManifestById(id: string): ScriptManifest | undefined {
  return manifests.find((m) => m.id === id);
}
