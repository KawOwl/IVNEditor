import {
  coreEventHistoryFromEnvelopes,
  type CoreEventHistoryReader,
} from '@ivn/core/game-session';
import { coreEventLogService } from '#internal/services/core-event-log';

export function createCoreEventHistoryReader(playthroughId: string): CoreEventHistoryReader {
  return {
    async readRecent(opts) {
      const envelopes = await coreEventLogService.loadLatest(playthroughId, opts.limit);
      return coreEventHistoryFromEnvelopes(envelopes);
    },

    async readRange(opts) {
      const envelopes = await coreEventLogService.loadRange(playthroughId, {
        fromSequence: opts.fromSequence,
        toSequence: opts.toSequence,
      });
      return coreEventHistoryFromEnvelopes(envelopes);
    },
  };
}
