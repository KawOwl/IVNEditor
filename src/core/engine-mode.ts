/**
 * Backend URL helper
 *
 * 6.6 之前这个文件还有一个 EngineMode 概念（local / remote），用来切换
 * 引擎是在浏览器内跑还是走后端 WebSocket。6.6 把前端 IndexedDB 和 local
 * 模式代码全部下线之后，只剩后端 URL 读取这一个职责。文件名保持
 * `engine-mode` 避免一堆 import 重命名——下次整理时再改。
 */

/**
 * 决定前端 fetch 的 base URL：
 *   - VITE_BACKEND_URL 显式配置 → 用它（部署时需要 cross-origin 的场景）
 *   - 生产 build（`bun run build`）→ 相对路径 `''`
 *     → fetch('/api/...') 跟页面同源，生产时前端是被后端 serve 的，天然同源
 *     → 不再把 'http://localhost:3001' 烙进 bundle（否则部署到任何其他
 *       hostname 下 API 都会打回本地 3001，踩过坑）
 *   - dev（`bun run dev`，Vite 5174）→ 'http://localhost:3001'
 *     → Vite 和后端分两个端口跑，必须跨源指到 3001
 */
export function getBackendUrl(): string {
  const explicit = import.meta.env.VITE_BACKEND_URL;
  if (explicit) return explicit;
  if (import.meta.env.PROD) return '';
  return 'http://localhost:3001';
}
