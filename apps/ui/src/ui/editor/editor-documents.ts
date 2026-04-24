import { estimateTokens } from '@ivn/core/tokens';
import type {
  MemoryConfig,
  PromptSegment,
  ScriptManifest,
  SegmentRole,
  StateSchema,
} from '@ivn/core/types';

export interface EditorDocument {
  id: string;
  filename: string;
  content: string;
  role: SegmentRole;
  priority: number;
  injectionCondition: string;
  injectionDescription: string;
  focusScene: string;
  derivedContent?: string;
  useDerived?: boolean;
}

export type EditorDocumentMetaField =
  | 'role'
  | 'priority'
  | 'injectionCondition'
  | 'injectionDescription'
  | 'focusScene'
  | 'filename'
  | 'useDerived';

export function createDocId(): string {
  return 'doc-' + Math.random().toString(36).slice(2, 8);
}

export function normalizeMarkdownFilename(name: string): string {
  return name.endsWith('.md') ? name : name + '.md';
}

export function createEmptyEditorDocument(filename: string): EditorDocument {
  return {
    id: createDocId(),
    filename: normalizeMarkdownFilename(filename),
    content: '',
    role: 'context',
    priority: 5,
    injectionCondition: '',
    injectionDescription: '',
    focusScene: '',
  };
}

export function createEditorDocumentFromFile(filename: string, content: string): EditorDocument {
  const nameLower = filename.toLowerCase();
  let role: SegmentRole = 'context';
  let priority = 5;
  let injectionCondition = '';
  let injectionDescription = '';

  if (nameLower.includes('gm_prompt') || nameLower.includes('gm prompt')) {
    role = 'system';
    priority = 0;
    if (nameLower.includes('第一章') || nameLower.includes('序章')) {
      injectionCondition = 'chapter === 1';
      injectionDescription = '第一章 GM 指令';
    } else if (nameLower.includes('第二章')) {
      injectionCondition = 'chapter === 2';
      injectionDescription = '第二章 GM 指令';
    }
  } else if (nameLower.includes('pc_prompt') || nameLower.includes('pc prompt')) {
    role = 'context';
    priority = 1;
    injectionCondition = "mode === 'auto-simulation'";
    injectionDescription = 'PC 模拟器指令（仅自动模拟模式）';
  }

  return {
    id: createDocId(),
    filename,
    content,
    role,
    priority,
    injectionCondition,
    injectionDescription,
    focusScene: '',
  };
}

export async function readEditorDocumentsFromFiles(files: FileList): Promise<EditorDocument[]> {
  const docs: EditorDocument[] = [];
  for (const file of Array.from(files)) {
    if (!file.name.endsWith('.md') && !file.name.endsWith('.txt')) continue;
    docs.push(createEditorDocumentFromFile(file.name, await file.text()));
  }
  return docs;
}

function simpleHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < Math.min(text.length, 1000); i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

export function docToSegment({
  id,
  filename,
  content,
  role,
  priority,
  injectionCondition,
  injectionDescription,
  focusScene,
  derivedContent,
  useDerived,
}: EditorDocument): PromptSegment {
  return {
    id,
    label: filename,
    content,
    contentHash: simpleHash(content),
    type: 'logic',
    sourceDoc: filename,
    role,
    priority,
    injectionRule: buildInjectionRule(injectionCondition, injectionDescription),
    focusTags: buildFocusTags(focusScene),
    tokenCount: estimateTokens(content),
    derivedContent,
    useDerived,
  };
}

function buildInjectionRule(
  condition: string,
  description: string,
): PromptSegment['injectionRule'] {
  return condition
    ? { description: description || condition, condition }
    : undefined;
}

function buildFocusTags(scene: string): PromptSegment['focusTags'] {
  return scene ? { scene } : undefined;
}

export function manifestToDocuments(manifest: ScriptManifest): EditorDocument[] {
  const seen = new Set<string>();
  const docs: EditorDocument[] = [];
  for (const chapter of manifest.chapters) {
    for (const seg of chapter.segments) {
      if (seen.has(seg.id)) continue;
      seen.add(seg.id);
      docs.push({
        id: seg.id,
        filename: seg.sourceDoc || seg.label,
        content: seg.content,
        role: seg.role,
        priority: seg.priority,
        injectionCondition: seg.injectionRule?.condition ?? '',
        injectionDescription: seg.injectionRule?.description ?? '',
        focusScene: seg.focusTags?.scene ?? '',
        derivedContent: seg.derivedContent,
        useDerived: seg.useDerived,
      });
    }
  }
  return docs;
}

export const defaultStateSchema: StateSchema = {
  variables: [
    { name: 'chapter', type: 'number', initial: 1, description: '当前章节' },
    { name: 'stage', type: 'number', initial: 1, description: '当前阶段序号' },
  ],
};

export const defaultMemoryConfig: MemoryConfig = {
  contextBudget: 200000,
  compressionThreshold: 160000,
  recencyWindow: 100,
};

export const defaultEnabledTools = [
  'read_state',
  'query_changelog',
  'pin_memory',
  'query_memory',
  'set_mood',
];
