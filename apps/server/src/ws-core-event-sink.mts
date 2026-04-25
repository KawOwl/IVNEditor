import {
  createSessionEmitterProjection,
  type CoreEventSink,
} from '@ivn/core/game-session';
import { createWebSocketEmitter } from '#internal/ws-session-emitter';

type WS = { send(data: string): void };

export function createWebSocketCoreEventSink(
  ws: WS,
  options?: { enableDebug?: boolean },
): CoreEventSink {
  return createSessionEmitterProjection(
    createWebSocketEmitter(ws, options),
  );
}
