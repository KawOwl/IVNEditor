/**
 * Memorax HTTP 客户端 —— 包 fetch 的薄层
 *
 * 职责：
 *   - 拼 baseUrl + path、带 `Authorization: Token <key>` header
 *   - 拆 envelope `{success, data, meta}`：success=false 抛 MemoraxError；data 直传
 *   - 失败统一走 `MemoraxError`（带 status / reason / message），便于上层做 fallback 判断
 *   - 为每次调用挂 AbortController 超时，避免无限阻塞游戏循环
 *
 * 不做：
 *   - 不重试；mem0 也没做，retry 留给 ParallelMemory 那层 fan-out 决定
 *   - 不 cache；Memorax 服务端自己有 dedupe，我们写进去就完事
 *   - 不 hold 状态；client 是 functional builder
 */

const DEFAULT_TIMEOUT_MS = 30_000;

export interface MemoraxClientConfig {
  baseUrl: string;
  apiKey: string;
  /** 默认 30s。Memorax 服务端 add 同步走 LLM 抽取最坏 20-30s；search 一般 1-2s。 */
  timeoutMs?: number;
}

export interface MemoraxMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: number;
}

export interface MemoraxAddRequest {
  messages: MemoraxMessage[];
  user_id: string;
  agent_id?: string;
  app_id?: string;
  session_id?: string;
  metadata?: Record<string, unknown>;
  /** true = 服务端入队后立即返回；false = 等 LLM 抽取完成才返回 */
  async_mode?: boolean;
}

export interface MemoraxAddEvent {
  id: string;
  event: string;
  data: { memory: string };
}

export interface MemoraxAddResult {
  task_id: string;
  status: string;
  data: MemoraxAddEvent[];
}

export type MemoraxFilterCondition = {
  agent_id?: { eq: string };
  app_id?: { eq: string };
  session_id?: { eq: string };
};

export interface MemoraxSearchRequest {
  query: string;
  user_id: string;
  filters?: { and?: MemoraxFilterCondition[]; or?: MemoraxFilterCondition[] };
  top_k?: number;
  rerank?: boolean;
  keyword_search?: boolean;
}

export interface MemoraxSearchItem {
  id: string;
  memory: string;
  user_id: string;
  agent_id: string | null;
  app_id: string | null;
  session_id: string | null;
  metadata?: Record<string, unknown> | null;
  created_at?: string;
  updated_at?: string;
}

export class MemoraxError extends Error {
  constructor(
    public readonly status: number,
    public readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'MemoraxError';
  }
}

export interface MemoraxClient {
  add(req: MemoraxAddRequest): Promise<MemoraxAddResult>;
  search(req: MemoraxSearchRequest): Promise<MemoraxSearchItem[]>;
}

export function createMemoraxClient(cfg: MemoraxClientConfig): MemoraxClient {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers = {
    Authorization: `Token ${cfg.apiKey}`,
    'Content-Type': 'application/json',
  };

  async function call<T>(path: string, body: unknown): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    let resp: Response;
    try {
      resp = await fetch(`${base}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      const reason = (err as Error).name === 'AbortError' ? 'timeout' : 'network-error';
      throw new MemoraxError(0, reason, `Memorax ${path}: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    const text = await resp.text();
    let parsed: { success?: boolean; data?: unknown; error?: { code?: string; message?: string } };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new MemoraxError(
        resp.status,
        'invalid-json',
        `Memorax ${path} returned non-JSON (${resp.status}): ${text.slice(0, 200)}`,
      );
    }

    if (!resp.ok || parsed.success === false) {
      const code = parsed.error?.code ?? `http-${resp.status}`;
      const msg = parsed.error?.message ?? `Memorax ${path} failed (${resp.status})`;
      throw new MemoraxError(resp.status, code, msg);
    }

    return parsed.data as T;
  }

  return {
    add: (req) => call<MemoraxAddResult>('/v1/memories/add', req),
    search: (req) => call<MemoraxSearchItem[]>('/v1/memories/search', req),
  };
}
