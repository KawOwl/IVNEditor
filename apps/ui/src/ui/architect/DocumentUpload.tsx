/**
 * DocumentUpload — 文档上传 + 分类 UI
 *
 * Step 2.1 的 UI 组件：
 *   - 拖拽或点击上传 .md 文件
 *   - 显示文档列表 + LLM 分类结果
 *   - 允许手动修改分类
 *   - 确认后进入提取阶段
 */

import { useCallback, useRef } from 'react';
import { useArchitectStore } from '@/stores/architect-store';
import type { DocumentRole, UploadedDocument } from '@ivn/core/architect/types';
import { estimateTokens } from '@ivn/core/tokens';
import { cn } from '@/lib/utils';

// ============================================================================
// Role Labels
// ============================================================================

const ROLE_LABELS: Record<DocumentRole, string> = {
  gm_prompt: 'GM 提示词',
  pc_prompt: 'PC 提示词',
  world_data: '世界观',
  location_data: '场景设定',
  character_data: '角色设定',
  rules: '规则文档',
  other: '其他',
};

const ROLE_COLORS: Record<DocumentRole, string> = {
  gm_prompt: 'bg-purple-900/50 text-purple-300',
  pc_prompt: 'bg-blue-900/50 text-blue-300',
  world_data: 'bg-green-900/50 text-green-300',
  location_data: 'bg-amber-900/50 text-amber-300',
  character_data: 'bg-pink-900/50 text-pink-300',
  rules: 'bg-cyan-900/50 text-cyan-300',
  other: 'bg-zinc-800 text-zinc-400',
};

// ============================================================================
// DocumentUpload Component
// ============================================================================

export interface DocumentUploadProps {
  onClassify: () => void;
  onConfirm: () => void;
}

export function DocumentUpload({ onClassify, onConfirm }: DocumentUploadProps) {
  const step = useArchitectStore((s) => s.step);
  const documents = useArchitectStore((s) => s.documents);
  const classifications = useArchitectStore((s) => s.classifications);
  const addDocuments = useArchitectStore((s) => s.addDocuments);
  const removeDocument = useArchitectStore((s) => s.removeDocument);
  const updateDocumentRole = useArchitectStore((s) => s.updateDocumentRole);
  const error = useArchitectStore((s) => s.error);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(async (files: FileList) => {
    const newDocs: UploadedDocument[] = [];
    for (const file of Array.from(files)) {
      if (!file.name.endsWith('.md') && !file.name.endsWith('.txt')) continue;
      const content = await file.text();
      newDocs.push({
        id: `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        filename: file.name,
        content,
        role: 'other',
        tokenCount: estimateTokens(content),
      });
    }
    if (newDocs.length > 0) {
      addDocuments(newDocs);
    }
  }, [addDocuments]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    handleFiles(e.dataTransfer.files);
  }, [handleFiles]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const isClassified = step === 'classified' || step === 'preview' || step === 'confirmed';

  return (
    <div className="flex flex-col gap-4 p-6">
      <h2 className="text-lg font-medium text-zinc-200">文档上传</h2>

      {/* Drop zone */}
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onClick={() => fileInputRef.current?.click()}
        className={cn(
          'border-2 border-dashed rounded p-8 text-center cursor-pointer transition-colors',
          'border-zinc-700 hover:border-zinc-500 text-zinc-500 hover:text-zinc-400',
        )}
      >
        <p>拖拽 .md / .txt 文件到此处，或点击选择</p>
        <p className="text-xs mt-1 text-zinc-600">支持多文件上传</p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".md,.txt"
          multiple
          className="hidden"
          onChange={(e) => e.target.files && handleFiles(e.target.files)}
        />
      </div>

      {/* Error */}
      {error && (
        <div className="text-sm text-red-400 bg-red-950/30 rounded px-3 py-2">{error}</div>
      )}

      {/* Document list */}
      {documents.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm text-zinc-400">
              已上传 {documents.length} 个文档
            </h3>
            <span className="text-xs text-zinc-600">
              共 {documents.reduce((sum, d) => sum + d.tokenCount, 0).toLocaleString()} tokens
            </span>
          </div>

          {documents.map((doc) => {
            const classification = classifications.find((c) => c.documentId === doc.id);
            return (
              <DocumentItem
                key={doc.id}
                doc={doc}
                classification={classification}
                isClassified={isClassified}
                onRemove={() => removeDocument(doc.id)}
                onRoleChange={(role, chapter) => updateDocumentRole(doc.id, role, chapter)}
              />
            );
          })}
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-3 mt-2">
        {step === 'upload' && documents.length > 0 && (
          <button
            onClick={onClassify}
            className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-500 transition-colors"
          >
            开始分类
          </button>
        )}
        {step === 'classifying' && (
          <div className="text-sm text-zinc-400 animate-pulse">正在分类文档...</div>
        )}
        {isClassified && (
          <button
            onClick={onConfirm}
            className="px-4 py-2 bg-green-600 text-white rounded text-sm hover:bg-green-500 transition-colors"
          >
            确认分类，开始提取
          </button>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// DocumentItem
// ============================================================================

function DocumentItem({
  doc,
  classification,
  isClassified,
  onRemove,
  onRoleChange,
}: {
  doc: UploadedDocument;
  classification?: { role: DocumentRole; chapter?: string; confidence: number; reasoning: string };
  isClassified: boolean;
  onRemove: () => void;
  onRoleChange: (role: DocumentRole, chapter?: string) => void;
}) {
  return (
    <div className="flex items-center gap-3 bg-zinc-900 rounded px-4 py-3">
      {/* Filename + tokens */}
      <div className="flex-1 min-w-0">
        <div className="text-sm text-zinc-200 truncate">{doc.filename}</div>
        <div className="text-xs text-zinc-600">{doc.tokenCount.toLocaleString()} tokens</div>
      </div>

      {/* Role badge / selector */}
      {isClassified ? (
        <select
          value={doc.role}
          onChange={(e) => onRoleChange(e.target.value as DocumentRole)}
          className="text-xs bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-300"
        >
          {Object.entries(ROLE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      ) : (
        <span className={cn('text-xs px-2 py-1 rounded', ROLE_COLORS[doc.role])}>
          {ROLE_LABELS[doc.role]}
        </span>
      )}

      {/* Confidence */}
      {classification && (
        <span className="text-xs text-zinc-600">
          {Math.round(classification.confidence * 100)}%
        </span>
      )}

      {/* Remove */}
      <button
        onClick={onRemove}
        className="text-zinc-600 hover:text-red-400 text-xs transition-colors"
      >
        ✕
      </button>
    </div>
  );
}
