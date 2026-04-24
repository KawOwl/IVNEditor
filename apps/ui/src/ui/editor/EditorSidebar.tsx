import { useCallback, useRef, type ChangeEvent } from 'react';
import type { EditorDocument } from '#internal/ui/editor/editor-documents';
import { FileListItem } from '#internal/ui/editor/FileListItem';
import { ScriptListEntry, type ScriptListItem } from '#internal/ui/editor/ScriptListEntry';

export interface EditorSidebarProps {
  documents: EditorDocument[];
  selectedDocId: string | null;
  scriptLabel: string;
  scriptList: ScriptListItem[];
  showScriptLibrary: boolean;
  saving: boolean;
  loadedScriptId: string | null;
  initialPrompt: string;
  onShowScriptLibraryChange: (show: boolean) => void;
  onSaveScript: () => void;
  onNewScript: () => void;
  onImportScript: (file: File) => void;
  onExportScript: () => void;
  onLoadScript: (id: string) => void;
  onRenameScript: (id: string, label: string) => void;
  onDeleteScript: (id: string) => void;
  onFilesUpload: (files: FileList) => void;
  onNewFile: () => void;
  onSelectDoc: (id: string) => void;
  onDeleteDoc: (id: string) => void;
  onRenameDoc: (id: string, name: string) => void;
  onInitialPromptChange: (value: string) => void;
}

export function EditorSidebar({
  documents,
  selectedDocId,
  scriptLabel,
  scriptList,
  showScriptLibrary,
  saving,
  loadedScriptId,
  initialPrompt,
  onShowScriptLibraryChange,
  onSaveScript,
  onNewScript,
  onImportScript,
  onExportScript,
  onLoadScript,
  onRenameScript,
  onDeleteScript,
  onFilesUpload,
  onNewFile,
  onSelectDoc,
  onDeleteDoc,
  onRenameDoc,
  onInitialPromptChange,
}: EditorSidebarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const handleFileInputChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onFilesUpload(e.target.files);
      e.target.value = '';
    }
  }, [onFilesUpload]);

  const handleImportInputChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) {
      onImportScript(e.target.files[0]);
      e.target.value = '';
    }
  }, [onImportScript]);

  return (
    <div className="w-56 flex-none border-r border-zinc-800 flex flex-col">
      <div className="flex-none px-3 py-2 border-b border-zinc-800 space-y-2">
        <div className="flex items-center gap-1">
          <button
            onClick={() => onShowScriptLibraryChange(!showScriptLibrary)}
            className="flex-1 text-left text-xs px-2 py-1.5 rounded bg-zinc-900 border border-zinc-700 text-zinc-300 hover:border-zinc-500 transition-colors truncate"
          >
            {scriptLabel || '选择剧本...'}
            <span className="text-zinc-600 ml-1">{showScriptLibrary ? '▲' : '▼'}</span>
          </button>
          <button
            onClick={onSaveScript}
            disabled={saving}
            className="flex-none text-[11px] px-1.5 py-1.5 rounded bg-emerald-800 hover:bg-emerald-700 text-white disabled:opacity-50 transition-colors"
            title="保存剧本"
          >
            {saving ? '...' : '保存'}
          </button>
        </div>

        {showScriptLibrary && (
          <div className="bg-zinc-900 border border-zinc-700 rounded overflow-hidden">
            <div className="flex border-b border-zinc-800">
              <button
                onClick={onNewScript}
                className="flex-1 text-[10px] py-1.5 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
              >
                新建
              </button>
              <button
                onClick={() => importInputRef.current?.click()}
                className="flex-1 text-[10px] py-1.5 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors border-l border-zinc-800"
              >
                导入
              </button>
              <button
                onClick={onExportScript}
                disabled={documents.length === 0}
                className="flex-1 text-[10px] py-1.5 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 disabled:opacity-30 transition-colors border-l border-zinc-800"
              >
                导出
              </button>
            </div>

            <div className="max-h-48 overflow-y-auto">
              {scriptList.length === 0 ? (
                <div className="px-2 py-3 text-center text-[10px] text-zinc-600">
                  暂无剧本
                </div>
              ) : (
                scriptList.map((item) => (
                  <ScriptListEntry
                    key={item.id}
                    item={item}
                    isActive={item.id === loadedScriptId}
                    onLoad={onLoadScript}
                    onRename={onRenameScript}
                    onDelete={onDeleteScript}
                  />
                ))
              )}
            </div>
          </div>
        )}

        <input
          ref={importInputRef}
          type="file"
          accept=".json,.ivn.json"
          className="hidden"
          onChange={handleImportInputChange}
        />

        <div className="flex gap-1">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex-1 text-[11px] px-2 py-1 rounded border border-dashed border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-300 transition-colors"
          >
            上传 .md
          </button>
          <button
            onClick={onNewFile}
            className="flex-1 text-[11px] px-2 py-1 rounded border border-dashed border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-300 transition-colors"
          >
            新建文件
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".md,.txt"
          multiple
          className="hidden"
          onChange={handleFileInputChange}
        />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {documents.length === 0 ? (
          <div className="px-3 py-8 text-center text-xs text-zinc-600">
            拖拽 .md 文件到此处
            <br />
            或点击上方按钮
          </div>
        ) : (
          <div className="py-1">
            {documents.map((doc) => (
              <FileListItem
                key={doc.id}
                doc={doc}
                selected={doc.id === selectedDocId}
                onSelect={() => onSelectDoc(doc.id)}
                onDelete={() => onDeleteDoc(doc.id)}
                onRename={(name) => onRenameDoc(doc.id, name)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="flex-none px-3 py-2 border-t border-zinc-800 space-y-1">
        <label className="text-[10px] text-zinc-500 uppercase tracking-wider">
          Initial Prompt
        </label>
        <input
          type="text"
          value={initialPrompt}
          onChange={(e) => onInitialPromptChange(e.target.value)}
          placeholder="首轮 user message"
          className="w-full text-xs px-2 py-1 rounded bg-zinc-900 border border-zinc-800 text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
        />
      </div>
    </div>
  );
}
