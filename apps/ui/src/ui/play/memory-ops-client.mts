/**
 * memory-ops-client —— 调 op-kit 的 memory.* op 的薄客户端
 *
 * 都走 POST /api/ops/:name + Authorization Bearer。
 * 失败抛 Error，调用方 catch 显示 toast。
 */

import { fetchWithAuth } from '#internal/stores/player-session-store';
import { getBackendUrl } from '@/lib/backend-url';
import type { MemoryReasonCode } from '@/stores/game-store';

interface OpResponseSuccess<T> {
  ok: true;
  data: T;
}

interface OpResponseError {
  ok: false;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

type OpResponse<T> = OpResponseSuccess<T> | OpResponseError;

async function callOp<T>(opName: string, input: unknown): Promise<T> {
  const url = `${getBackendUrl()}/api/ops/${opName}`;
  const res = await fetchWithAuth(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const json = (await res.json()) as OpResponse<T>;
  if (!json.ok) {
    throw new Error(`[op:${opName}] ${json.code}: ${json.message}`);
  }
  return json.data;
}

// ============================================================================
// memory.list_turn_retrievals
// ============================================================================

export interface ListTurnRetrievalsRetrieval {
  id: string;
  turn: number;
  source: 'context-assembly' | 'tool-call';
  query: string;
  entries: Array<{
    id: string;
    turn: number;
    role: 'generate' | 'receive' | 'system';
    content: string;
    tokenCount: number;
    timestamp: number;
    pinned?: boolean;
  }>;
  summary: string;
  retrievedAt: string;
}

export interface ListTurnRetrievalsResult {
  retrievals: ListTurnRetrievalsRetrieval[];
  activeDeletions: Array<{
    annotationId: string;
    memoryEntryId: string;
    reasonCode: MemoryReasonCode;
  }>;
}

export function callListTurnRetrievals(input: {
  playthroughId: string;
  turn?: number;
  limit?: number;
}): Promise<ListTurnRetrievalsResult> {
  return callOp<ListTurnRetrievalsResult>('memory.list_turn_retrievals', input);
}

// ============================================================================
// memory.mark_deleted
// ============================================================================

export interface MarkDeletedResult {
  annotationId: string;
  memoryEntryId: string;
  reasonCode: MemoryReasonCode;
  createdAt: string;
}

export function callMarkDeleted(input: {
  turnMemoryRetrievalId: string;
  memoryEntryId: string;
  reasonCode: MemoryReasonCode;
  reasonText?: string;
}): Promise<MarkDeletedResult> {
  return callOp<MarkDeletedResult>('memory.mark_deleted', input);
}

// ============================================================================
// memory.cancel_deletion
// ============================================================================

export interface CancelDeletionResult {
  annotationId: string;
  cancelledAt: string;
}

export function callCancelDeletion(input: {
  annotationId: string;
}): Promise<CancelDeletionResult> {
  return callOp<CancelDeletionResult>('memory.cancel_deletion', input);
}
