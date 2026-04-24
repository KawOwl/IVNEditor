/**
 * ArchitectStore — Zustand store for Architect Agent workflow
 *
 * Manages the document upload → classification → extraction pipeline state.
 */

import { create } from 'zustand';
import type {
  UploadedDocument,
  ClassificationResult,
  ArchitectResult,
  DocumentRole,
} from '@ivn/core/architect/types';

export type ArchitectStep =
  | 'upload'           // 上传文档
  | 'classifying'      // 正在分类
  | 'classified'       // 分类完成，待确认
  | 'extracting'       // 正在提取
  | 'preview'          // 提取完成，预览确认
  | 'confirmed';       // 编剧确认，输出 IR

export interface ArchitectState {
  step: ArchitectStep;
  documents: UploadedDocument[];
  classifications: ClassificationResult[];
  result: ArchitectResult | null;
  extractionProgress: string | null;   // current extraction step message
  error: string | null;

  // Actions
  addDocuments: (docs: UploadedDocument[]) => void;
  removeDocument: (id: string) => void;
  setClassifications: (classifications: ClassificationResult[]) => void;
  updateDocumentRole: (docId: string, role: DocumentRole, chapter?: string) => void;
  setStep: (step: ArchitectStep) => void;
  setResult: (result: ArchitectResult) => void;
  setExtractionProgress: (message: string | null) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

const initialState = {
  step: 'upload' as const,
  documents: [],
  classifications: [],
  result: null,
  extractionProgress: null,
  error: null,
};

export const useArchitectStore = create<ArchitectState>((set) => ({
  ...initialState,

  addDocuments: (docs) =>
    set((state) => ({
      documents: [...state.documents, ...docs],
    })),

  removeDocument: (id) =>
    set((state) => ({
      documents: state.documents.filter((d) => d.id !== id),
      classifications: state.classifications.filter((c) => c.documentId !== id),
    })),

  setClassifications: (classifications) =>
    set({ classifications }),

  updateDocumentRole: (docId, role, chapter) =>
    set((state) => ({
      documents: state.documents.map((d) =>
        d.id === docId ? { ...d, role, chapter } : d,
      ),
      classifications: state.classifications.map((c) =>
        c.documentId === docId ? { ...c, role, chapter } : c,
      ),
    })),

  setStep: (step) => set({ step }),
  setResult: (result) => set({ result }),
  setExtractionProgress: (extractionProgress) => set({ extractionProgress }),
  setError: (error) => set({ error }),
  reset: () => set(initialState),
}));
