/**
 * Backend URL helper
 *
 * 6.6 之前这个文件还有一个 EngineMode 概念（local / remote），用来切换
 * 引擎是在浏览器内跑还是走后端 WebSocket。6.6 把前端 IndexedDB 和 local
 * 模式代码全部下线之后，只剩后端 URL 读取这一个职责。文件名保持
 * `engine-mode` 避免一堆 import 重命名——下次整理时再改。
 */

export function getBackendUrl(): string {
  return import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:3001';
}
