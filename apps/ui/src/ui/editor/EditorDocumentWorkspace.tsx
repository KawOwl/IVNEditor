import { CodeEditor } from './CodeEditor';
import { DiffEditor } from './DiffEditor';
import { DocMetaBar } from './DocMetaBar';
import { VersionHistoryList, type VersionSummary } from './VersionHistoryList';
import { cn } from '@/lib/utils';
import type { EditorDocument, EditorDocumentMetaField } from './editor-documents';
import type { RewriteProgress } from './use-ai-rewrite';
import type { StateVarInfo } from '@/lib/editor/completion-sources';

export interface EditorDocumentWorkspaceProps {
  documentsCount: number;
  selectedDoc: EditorDocument | null;
  loadedScriptId: string | null;
  loadedVersionId: string | null;
  versionList: VersionSummary[];
  versionListLoading: boolean;
  publishingVersionId: string | null;
  stateVars: StateVarInfo[];
  rewritingDocId: string | null;
  rewriteProgress: RewriteProgress | null;
  onSelectVersion: (versionId: string) => void;
  onPublishVersion: (versionId: string) => void;
  onDocMetaChange: (
    id: string,
    field: EditorDocumentMetaField,
    value: string | number | boolean,
  ) => void;
  onContentChange: (content: string) => void;
  onRewriteDoc: (docId: string) => void;
  onClearDerivedDoc: (docId: string) => void;
}

export function EditorDocumentWorkspace({
  documentsCount,
  selectedDoc,
  loadedScriptId,
  loadedVersionId,
  versionList,
  versionListLoading,
  publishingVersionId,
  stateVars,
  rewritingDocId,
  rewriteProgress,
  onSelectVersion,
  onPublishVersion,
  onDocMetaChange,
  onContentChange,
  onRewriteDoc,
  onClearDerivedDoc,
}: EditorDocumentWorkspaceProps) {
  return (
    <>
      <VersionHistoryList
        currentVersionId={loadedVersionId}
        hasScript={!!loadedScriptId}
        versions={versionList}
        loading={versionListLoading}
        onSelect={onSelectVersion}
        onPublish={onPublishVersion}
        publishingVersionId={publishingVersionId}
      />

      <div className="flex-1 min-w-0 flex flex-col">
        {selectedDoc ? (
          <>
            <DocMetaBar
              doc={selectedDoc}
              onMetaChange={(field, value) => onDocMetaChange(selectedDoc.id, field, value)}
              onRewrite={() => onRewriteDoc(selectedDoc.id)}
              rewriting={rewritingDocId === selectedDoc.id}
              rewriteProgress={
                rewritingDocId === selectedDoc.id ? rewriteProgress : null
              }
            />

            <div className="flex-1 min-h-0 flex">
              <div className={cn('min-h-0', selectedDoc.derivedContent ? 'flex-1' : 'w-full')}>
                <CodeEditor
                  value={selectedDoc.content}
                  onChange={onContentChange}
                  stateVars={stateVars}
                />
              </div>

              {selectedDoc.derivedContent && (
                <div className="flex-1 min-h-0 border-l border-zinc-800 flex flex-col">
                  <div className="flex-none px-3 py-1.5 border-b border-zinc-800 flex items-center justify-between">
                    <span className="text-[10px] text-violet-400 font-medium">
                      原文 vs AI 衍生版
                    </span>
                    <button
                      onClick={() => onClearDerivedDoc(selectedDoc.id)}
                      className="text-[10px] text-zinc-600 hover:text-red-400 transition-colors"
                    >
                      删除衍生
                    </button>
                  </div>
                  <DiffEditor
                    original={selectedDoc.content}
                    modified={selectedDoc.derivedContent}
                    className="flex-1 min-h-0"
                  />
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-zinc-600 text-sm">
            {documentsCount === 0
              ? '上传 Markdown 文件开始编辑'
              : '选择左侧文件开始编辑'}
          </div>
        )}
      </div>
    </>
  );
}
