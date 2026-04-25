/**
 * @deprecated Import from `@ivn/core/legacy-session-emitter` instead.
 *
 * `SessionEmitter` is retained as a compatibility target for legacy WebSocket,
 * recording, and debug consumers. New runtime code should publish CoreEvents.
 */

export type {
  DebugSnapshot,
  SessionEmitter,
  SessionStatus,
} from '#internal/legacy-session-emitter';
