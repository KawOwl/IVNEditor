/**
 * Storage Layer Interface — abstract contract for persisting script bundles.
 * A "script" (剧本) bundles all assets needed to run a game session.
 */

import { z } from 'zod';
import {
  CharacterStateSchema,
  WorldEventSchema,
  GOAPActionSchema,
} from '../memory/schemas';

// ─── Script Metadata Schema ────────────────────────────

export const ScriptMetadataSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional().default(''),
  author: z.string().optional().default(''),
  createdAt: z.number(),
  updatedAt: z.number(),
  version: z.number().default(1),
  source: z.enum(['builtin', 'uploaded', 'generated']),
});

// ─── Chapter Data Schema ───────────────────────────────

export const LocationSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export const ChapterDataSchema = z.object({
  chapter: z.string(),
  events: z.array(WorldEventSchema),
  locations: z.array(LocationSchema),
});

// ─── Full Script Bundle Schema ─────────────────────────

export const ScriptBundleSchema = z.object({
  metadata: ScriptMetadataSchema,
  characters: z.array(CharacterStateSchema).min(1),
  chapters: z.array(ChapterDataSchema).min(1),
  goapActions: z.array(GOAPActionSchema).min(1),
});

// ─── Type Exports ──────────────────────────────────────

export type ScriptMetadata = z.infer<typeof ScriptMetadataSchema>;
export type ChapterData = z.infer<typeof ChapterDataSchema>;
export type ScriptBundle = z.infer<typeof ScriptBundleSchema>;

// ─── Abstract Storage Interface ────────────────────────

export interface IScriptStorage {
  /** Initialize storage (open DB, create tables, etc.) */
  init(): Promise<void>;

  /** Get all script metadata (lightweight, no full bundles) */
  listScripts(): Promise<ScriptMetadata[]>;

  /** Get a full script bundle by ID */
  getScript(id: string): Promise<ScriptBundle | null>;

  /** Save a new script or overwrite an existing one */
  saveScript(script: ScriptBundle): Promise<void>;

  /** Delete a script by ID */
  deleteScript(id: string): Promise<void>;

  /** Check if a script exists */
  hasScript(id: string): Promise<boolean>;
}
