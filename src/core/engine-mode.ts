/**
 * Engine Mode — 运行模式切换
 *
 * 通过 Vite 环境变量 VITE_ENGINE_MODE 控制：
 *   - 'local'  (default): 引擎在浏览器内运行，编剧试玩模式
 *   - 'remote': 引擎在后端运行，通过 WebSocket 推流，玩家模式
 *
 * VITE_BACKEND_URL: 后端地址（remote 模式必填）
 */

export type EngineMode = 'local' | 'remote';

export function getEngineMode(): EngineMode {
  const mode = import.meta.env.VITE_ENGINE_MODE;
  if (mode === 'remote') return 'remote';
  return 'local';
}

export function getBackendUrl(): string {
  return import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:3001';
}
