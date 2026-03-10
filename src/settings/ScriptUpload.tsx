/**
 * ScriptUpload — Tab 2: JSON upload + Zod validation + preview.
 */

import { useState, useCallback } from 'react';
import { useSettingsStore } from './settings-store';
import { ScriptBundleSchema, type ScriptBundle } from '../storage/storage-interface';

const TEMPLATE: object = {
  metadata: {
    id: "my-script-01",
    name: "剧本名称",
    description: "剧本简介",
    author: "作者名",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    version: 1,
    source: "uploaded",
  },
  characters: [
    {
      core: {
        id: "protagonist",
        name: "主角名",
        background: "角色背景故事（100-200字）",
        personality: [
          { trait: "勇敢", intensity: 0.8 },
          { trait: "谨慎", intensity: 0.6 },
          { trait: "善良", intensity: 0.7 },
        ],
        values: ["正义", "自由"],
        speechStyle: "说话风格描述",
        appearance: "外貌描述",
      },
      longTermGoals: [
        { id: "main-goal", description: "主要长期目标", priority: 10 },
      ],
      shortTermGoals: [],
      personaShifts: [],
    },
  ],
  chapters: [
    {
      chapter: "第一章：章节名",
      events: [
        {
          id: "event-01",
          time: 600,
          name: "事件名称",
          description: "事件详细描述",
          location: "location-01",
          affectedCharacters: ["protagonist"],
          severity: "minor",
        },
      ],
      locations: [
        { id: "location-01", name: "地点名称" },
        { id: "location-02", name: "另一个地点" },
      ],
    },
  ],
  goapActions: [
    {
      id: "go-to",
      name: "前往目的地",
      preconditions: {},
      effects: { atDestination: true },
      cost: 1,
      timeCost: 30,
      description: "前往指定地点",
    },
    {
      id: "investigate",
      name: "调查线索",
      preconditions: { atDestination: true },
      effects: { hasClue: true },
      cost: 2,
      timeCost: 40,
      description: "在当前地点寻找线索",
    },
  ],
};

function downloadTemplate() {
  const json = JSON.stringify(TEMPLATE, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'script-template.json';
  a.click();
  URL.revokeObjectURL(url);
}

export function ScriptUpload() {
  const [jsonText, setJsonText] = useState('');
  const [preview, setPreview] = useState<ScriptBundle | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const saveScript = useSettingsStore((s) => s.saveScript);
  const setTab = useSettingsStore((s) => s.setTab);

  const handleValidate = useCallback((text: string) => {
    setPreview(null);
    setValidationError(null);
    setSaved(false);

    if (!text.trim()) return;

    try {
      const raw = JSON.parse(text);
      const result = ScriptBundleSchema.safeParse(raw);
      if (result.success) {
        setPreview(result.data);
      } else {
        const errors = result.error.issues
          .map((i) => `${i.path.join('.')}：${i.message}`)
          .join('\n');
        setValidationError(errors);
      }
    } catch (err) {
      setValidationError(`JSON 解析失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  const handleFileUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const text = reader.result as string;
        setJsonText(text);
        handleValidate(text);
      };
      reader.readAsText(file);
    },
    [handleValidate],
  );

  const handleSave = useCallback(async () => {
    if (!preview) return;
    // Ensure unique ID and timestamps for uploaded scripts
    const toSave: ScriptBundle = {
      ...preview,
      metadata: {
        ...preview.metadata,
        id: preview.metadata.id || `upload-${Date.now()}`,
        source: 'uploaded',
        createdAt: preview.metadata.createdAt || Date.now(),
        updatedAt: Date.now(),
      },
    };
    await saveScript(toSave);
    setSaved(true);
    setTimeout(() => {
      setTab('select');
    }, 800);
  }, [preview, saveScript, setTab]);

  return (
    <div style={styles.container}>
      {/* Template download hint */}
      <div style={styles.templateBar}>
        <span style={styles.templateText}>不确定格式？</span>
        <button style={styles.templateBtn} onClick={downloadTemplate}>
          下载 JSON 模板
        </button>
      </div>

      {/* File upload */}
      <label style={styles.dropZone}>
        <input
          type="file"
          accept=".json"
          onChange={handleFileUpload}
          style={{ display: 'none' }}
        />
        <span style={styles.dropText}>📁 点击选择 .json 文件</span>
        <span style={styles.dropHint}>或在下方粘贴 JSON 内容</span>
      </label>

      {/* JSON textarea */}
      <textarea
        style={styles.textarea}
        value={jsonText}
        onChange={(e) => setJsonText(e.target.value)}
        placeholder="粘贴 ScriptBundle JSON 到此处..."
        rows={10}
      />

      <button
        style={styles.validateBtn}
        onClick={() => handleValidate(jsonText)}
        disabled={!jsonText.trim()}
      >
        校验 JSON
      </button>

      {/* Validation error */}
      {validationError && (
        <div style={styles.errorBox}>
          <strong>校验失败：</strong>
          <pre style={styles.errorPre}>{validationError}</pre>
        </div>
      )}

      {/* Preview */}
      {preview && (
        <div style={styles.previewBox}>
          <h4 style={styles.previewTitle}>✅ 校验通过</h4>
          <p style={styles.previewLine}>
            📖 <strong>{preview.metadata.name}</strong>
          </p>
          <p style={styles.previewLine}>
            👤 角色：{preview.characters.map((c) => c.core.name).join('、')}
          </p>
          <p style={styles.previewLine}>
            📅 章节：{preview.chapters.length} 章 · {preview.chapters.reduce((n, ch) => n + ch.events.length, 0)} 事件
          </p>
          <p style={styles.previewLine}>
            ⚙️ GOAP 动作：{preview.goapActions.length} 个
          </p>
          <button
            style={{
              ...styles.saveBtn,
              ...(saved ? styles.saveBtnDone : {}),
            }}
            onClick={handleSave}
            disabled={saved}
          >
            {saved ? '✅ 已保存' : '💾 保存剧本'}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Styles ────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  templateBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 12px',
    background: 'rgba(102, 126, 234, 0.08)',
    borderRadius: '6px',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'rgba(102, 126, 234, 0.2)',
  },
  templateText: {
    color: '#888',
    fontSize: '12px',
  },
  templateBtn: {
    padding: '4px 12px',
    background: 'rgba(102, 126, 234, 0.2)',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: '#667eea',
    borderRadius: '4px',
    color: '#7ec8e3',
    fontSize: '12px',
    cursor: 'pointer',
  },
  dropZone: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px',
    borderWidth: '2px',
    borderStyle: 'dashed',
    borderColor: 'rgba(255,255,255,0.15)',
    borderRadius: '8px',
    cursor: 'pointer',
    background: 'rgba(255,255,255,0.02)',
  },
  dropText: {
    color: '#7ec8e3',
    fontSize: '14px',
  },
  dropHint: {
    color: '#666',
    fontSize: '11px',
    marginTop: '4px',
  },
  textarea: {
    width: '100%',
    padding: '10px',
    background: 'rgba(0,0,0,0.3)',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: '6px',
    color: '#ccc',
    fontSize: '12px',
    fontFamily: 'monospace',
    resize: 'vertical' as const,
    boxSizing: 'border-box' as const,
  },
  validateBtn: {
    padding: '8px 16px',
    background: 'rgba(102, 126, 234, 0.2)',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: '#667eea',
    borderRadius: '6px',
    color: '#7ec8e3',
    fontSize: '13px',
    cursor: 'pointer',
    alignSelf: 'flex-start',
  },
  errorBox: {
    padding: '10px 14px',
    background: 'rgba(255, 80, 80, 0.1)',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'rgba(255, 80, 80, 0.3)',
    borderRadius: '6px',
    color: '#ff8888',
    fontSize: '12px',
  },
  errorPre: {
    margin: '6px 0 0',
    whiteSpace: 'pre-wrap' as const,
    fontSize: '11px',
    lineHeight: '1.5',
  },
  previewBox: {
    padding: '12px 16px',
    background: 'rgba(78, 205, 196, 0.08)',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'rgba(78, 205, 196, 0.3)',
    borderRadius: '8px',
  },
  previewTitle: {
    color: '#4ecdc4',
    fontSize: '14px',
    margin: '0 0 8px',
  },
  previewLine: {
    color: '#ccc',
    fontSize: '12px',
    margin: '4px 0',
  },
  saveBtn: {
    marginTop: '10px',
    padding: '8px 20px',
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    borderWidth: '0',
    borderStyle: 'none',
    borderRadius: '6px',
    color: 'white',
    fontSize: '13px',
    cursor: 'pointer',
  },
  saveBtnDone: {
    background: '#2d8659',
    cursor: 'default',
  },
};
