import { asc, desc, eq } from 'drizzle-orm';
import type {
  CoreEventEnvelope,
  CoreEventLogWriter,
} from '@ivn/core/game-session';
import { db, schema } from '#internal/db';

export class CoreEventLogService {
  async append(envelope: CoreEventEnvelope): Promise<void> {
    await db.insert(schema.coreEventEnvelopes).values({
      id: crypto.randomUUID(),
      playthroughId: envelope.playthroughId,
      schemaVersion: envelope.schemaVersion,
      sequence: envelope.sequence,
      occurredAt: envelope.occurredAt,
      event: envelope.event,
    });
  }

  async getLastSequence(playthroughId: string): Promise<number> {
    const rows = await db
      .select({ sequence: schema.coreEventEnvelopes.sequence })
      .from(schema.coreEventEnvelopes)
      .where(eq(schema.coreEventEnvelopes.playthroughId, playthroughId))
      .orderBy(desc(schema.coreEventEnvelopes.sequence))
      .limit(1);
    return rows[0]?.sequence ?? 0;
  }

  async load(playthroughId: string): Promise<CoreEventEnvelope[]> {
    const rows = await db
      .select()
      .from(schema.coreEventEnvelopes)
      .where(eq(schema.coreEventEnvelopes.playthroughId, playthroughId))
      .orderBy(asc(schema.coreEventEnvelopes.sequence));

    return rows.map((row) => ({
      schemaVersion: row.schemaVersion as CoreEventEnvelope['schemaVersion'],
      sequence: row.sequence,
      occurredAt: row.occurredAt,
      playthroughId: row.playthroughId,
      event: row.event,
    }));
  }

  createWriter(): CoreEventLogWriter {
    return {
      append: (envelope) => this.append(envelope),
    };
  }
}

export const coreEventLogService = new CoreEventLogService();
