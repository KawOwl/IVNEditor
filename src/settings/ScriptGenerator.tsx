/**
 * ScriptGenerator — Tab 3: AI-powered script generation.
 * User inputs plain text → DeepSeek generates → Zod validates → save.
 */

import { useState, useCallback } from 'react';
import { useSettingsStore } from './settings-store';
import { generateScript } from '../agents/script-generator';
import type { ScriptBundle } from '../storage/storage-interface';
import { T } from '../theme';

export function ScriptGenerator() {
  const [description, setDescription] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [preview, setPreview] = useState<ScriptBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [duration, setDuration] = useState(0);
  const saveScript = useSettingsStore((s) => s.saveScript);
  const setTab = useSettingsStore((s) => s.setTab);

  const handleGenerate = useCallback(async () => {
    if (!description.trim()) return;
    setIsGenerating(true);
    setError(null);
    setPreview(null);
    setSaved(false);

    try {
      const result = await generateScript(description.trim());
      setPreview(result.script);
      setDuration(result.durationMs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsGenerating(false);
    }
  }, [description]);

  const handleSave = useCallback(async () => {
    if (!preview) return;
    await saveScript(preview);
    setSaved(true);
    setTimeout(() => {
      setTab('select');
    }, 800);
  }, [preview, saveScript, setTab]);

  return (
    <div style={styles.container}>
      <p style={styles.hint}>
        输入角色设定和世界观描述，AI 将自动生成符合标准格式的剧本数据。
      </p>

      {/* Description input */}
      <textarea
        style={styles.textarea}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder={`示例：\n\n主角是一个叫"白夜"的年轻法师，在一座被黑暗笼罩的城市中寻找失踪的师父。\n城市叫"暮光城"，分为上城（贵族区）和下城（贫民窟），有一个地下黑市和古老的魔法学院。\n世界中魔法正在衰退，某些人开始研究禁术...`}
        rows={8}
        disabled={isGenerating}
      />

      {/* Generate button */}
      <button
        style={{
          ...styles.generateBtn,
          opacity: description.trim() && !isGenerating ? 1 : 0.4,
        }}
        onClick={handleGenerate}
        disabled={!description.trim() || isGenerating}
      >
        {isGenerating ? '⏳ 正在生成（约 10-30 秒）...' : '✨ 生成剧本'}
      </button>

      {/* Error */}
      {error && (
        <div style={styles.errorBox}>
          <strong>生成失败：</strong>
          <p style={{ margin: '6px 0 0', fontSize: '11px' }}>{error}</p>
          <button style={styles.retryBtn} onClick={handleGenerate}>
            🔄 重试
          </button>
        </div>
      )}

      {/* Preview */}
      {preview && (
        <div style={styles.previewBox}>
          <h4 style={styles.previewTitle}>
            ✅ 生成成功
            <span style={styles.durationTag}>
              {(duration / 1000).toFixed(1)}s
            </span>
          </h4>
          <p style={styles.previewLine}>
            📖 <strong>{preview.metadata.name}</strong>
          </p>
          <div style={styles.previewSection}>
            <strong style={styles.sectionTitle}>👤 角色</strong>
            {preview.characters.map((c) => (
              <p key={c.core.id} style={styles.previewDetail}>
                {c.core.name} — {c.core.background.slice(0, 60)}...
              </p>
            ))}
          </div>
          <div style={styles.previewSection}>
            <strong style={styles.sectionTitle}>🌍 事件</strong>
            {preview.chapters[0]?.events.map((e) => (
              <p key={e.id} style={styles.previewDetail}>
                {Math.floor(e.time / 60)
                  .toString()
                  .padStart(2, '0')}
                :
                {(e.time % 60).toString().padStart(2, '0')}{' '}
                {e.name} [{e.severity}]
              </p>
            ))}
          </div>
          <div style={styles.previewSection}>
            <strong style={styles.sectionTitle}>⚙️ GOAP 动作</strong>
            <p style={styles.previewDetail}>
              {preview.goapActions.map((a) => a.name).join('、')}
            </p>
          </div>
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
  hint: {
    color: T.textTertiary,
    fontSize: '12px',
    margin: 0,
    lineHeight: '1.5',
  },
  textarea: {
    width: '100%',
    padding: '12px',
    background: T.bg,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: T.border,
    borderRadius: T.radiusLg,
    color: T.textSecondary,
    fontSize: '13px',
    fontFamily: 'inherit',
    resize: 'vertical' as const,
    lineHeight: '1.6',
    boxSizing: 'border-box' as const,
  },
  generateBtn: {
    padding: '10px 24px',
    background: T.accent,
    borderWidth: '0',
    borderStyle: 'none',
    borderRadius: T.radiusLg,
    color: 'white',
    fontSize: '14px',
    fontWeight: 'bold',
    cursor: 'pointer',
    alignSelf: 'flex-start',
  },
  errorBox: {
    padding: '10px 14px',
    background: T.errorMuted,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: T.error,
    borderRadius: T.radius,
    color: T.error,
    fontSize: '12px',
  },
  retryBtn: {
    marginTop: '8px',
    padding: '4px 12px',
    background: T.bgSurface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: T.borderStrong,
    borderRadius: '4px',
    color: T.textSecondary,
    fontSize: '11px',
    cursor: 'pointer',
  },
  previewBox: {
    padding: '14px 16px',
    background: T.successMuted,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: T.success,
    borderRadius: T.radiusLg,
  },
  previewTitle: {
    color: T.success,
    fontSize: '14px',
    margin: '0 0 10px',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  durationTag: {
    fontSize: '11px',
    color: T.textTertiary,
    fontWeight: 'normal',
  },
  previewLine: {
    color: T.textSecondary,
    fontSize: '13px',
    margin: '4px 0',
  },
  previewSection: {
    margin: '10px 0',
  },
  sectionTitle: {
    color: T.textSecondary,
    fontSize: '12px',
    display: 'block',
    marginBottom: '4px',
  },
  previewDetail: {
    color: T.textTertiary,
    fontSize: '11px',
    margin: '2px 0 2px 12px',
    lineHeight: '1.4',
  },
  saveBtn: {
    marginTop: '12px',
    padding: '8px 20px',
    background: T.accent,
    borderWidth: '0',
    borderStyle: 'none',
    borderRadius: T.radius,
    color: 'white',
    fontSize: '13px',
    cursor: 'pointer',
  },
  saveBtnDone: {
    background: T.success,
    cursor: 'default',
  },
};
