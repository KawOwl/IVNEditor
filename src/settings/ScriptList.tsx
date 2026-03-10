/**
 * ScriptList — Tab 1: Script selection list with cards.
 * Shows all saved scripts, allows selecting and deleting.
 */

import { useState } from 'react';
import { useSettingsStore } from './settings-store';
import { BUILTIN_SCRIPT_ID } from '../storage/seed';
import type { ScriptMetadata } from '../storage/storage-interface';

interface ScriptListProps {
  onStartGame: () => void;
}

const sourceBadges: Record<string, { label: string; color: string }> = {
  builtin: { label: '内置', color: '#667eea' },
  uploaded: { label: '上传', color: '#4ecdc4' },
  generated: { label: '生成', color: '#e6c3a1' },
};

export function ScriptList({ onStartGame }: ScriptListProps) {
  const scripts = useSettingsStore((s) => s.scripts);
  const activeScriptId = useSettingsStore((s) => s.activeScriptId);
  const activeScript = useSettingsStore((s) => s.activeScript);
  const selectScript = useSettingsStore((s) => s.selectScript);
  const deleteScript = useSettingsStore((s) => s.deleteScript);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const handleDelete = async (id: string) => {
    if (confirmDeleteId === id) {
      await deleteScript(id);
      setConfirmDeleteId(null);
    } else {
      setConfirmDeleteId(id);
    }
  };

  return (
    <div style={styles.container}>
      {scripts.length === 0 ? (
        <p style={styles.emptyText}>暂无剧本，请上传或生成一个剧本。</p>
      ) : (
        <div style={styles.list}>
          {scripts.map((script) => (
            <ScriptCard
              key={script.id}
              script={script}
              isSelected={script.id === activeScriptId}
              onSelect={() => selectScript(script.id)}
              onDelete={
                script.id !== BUILTIN_SCRIPT_ID
                  ? () => handleDelete(script.id)
                  : undefined
              }
              isConfirmingDelete={confirmDeleteId === script.id}
            />
          ))}
        </div>
      )}

      {/* Start game button */}
      <button
        style={{
          ...styles.startBtn,
          opacity: activeScript ? 1 : 0.4,
        }}
        onClick={onStartGame}
        disabled={!activeScript}
      >
        ▶ 开始游戏
        {activeScript && (
          <span style={styles.startBtnSub}>
            {' '}— {activeScript.metadata.name}
          </span>
        )}
      </button>
    </div>
  );
}

// ─── ScriptCard sub-component ──────────────────────────

function ScriptCard({
  script,
  isSelected,
  onSelect,
  onDelete,
  isConfirmingDelete,
}: {
  script: ScriptMetadata;
  isSelected: boolean;
  onSelect: () => void;
  onDelete?: () => void;
  isConfirmingDelete: boolean;
}) {
  const badge = sourceBadges[script.source] || sourceBadges.uploaded;

  return (
    <div
      style={{
        ...styles.card,
        ...(isSelected ? styles.cardSelected : {}),
      }}
      onClick={onSelect}
    >
      <div style={styles.cardHeader}>
        <span style={styles.cardName}>{script.name}</span>
        <span
          style={{
            ...styles.badge,
            background: `${badge.color}33`,
            color: badge.color,
            borderColor: `${badge.color}66`,
          }}
        >
          {badge.label}
        </span>
      </div>
      {script.description && (
        <p style={styles.cardDesc}>{script.description}</p>
      )}
      <div style={styles.cardFooter}>
        <span style={styles.cardMeta}>
          {script.updatedAt > 0
            ? new Date(script.updatedAt).toLocaleDateString('zh-CN')
            : '默认'}
        </span>
        {onDelete && (
          <button
            style={{
              ...styles.deleteBtn,
              ...(isConfirmingDelete ? styles.deleteBtnConfirm : {}),
            }}
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            {isConfirmingDelete ? '确认删除' : '🗑️'}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Styles ────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    height: '100%',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    flex: 1,
    overflow: 'auto',
  },
  emptyText: {
    color: '#666',
    fontSize: '13px',
    textAlign: 'center',
    marginTop: '40px',
  },
  card: {
    padding: '12px 16px',
    background: 'rgba(255,255,255,0.04)',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: '8px',
    cursor: 'pointer',
    transition: 'border-color 0.2s',
  },
  cardSelected: {
    borderColor: '#e6c3a1',
    background: 'rgba(230, 195, 161, 0.08)',
  },
  cardHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
  },
  cardName: {
    color: '#e0e0e0',
    fontSize: '14px',
    fontWeight: 'bold',
  },
  badge: {
    padding: '2px 8px',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderRadius: '10px',
    fontSize: '10px',
    whiteSpace: 'nowrap' as const,
  },
  cardDesc: {
    color: '#999',
    fontSize: '12px',
    margin: '6px 0 0',
    lineHeight: '1.4',
  },
  cardFooter: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: '8px',
  },
  cardMeta: {
    color: '#666',
    fontSize: '11px',
  },
  deleteBtn: {
    padding: '2px 8px',
    background: 'transparent',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: '4px',
    color: '#888',
    fontSize: '11px',
    cursor: 'pointer',
  },
  deleteBtnConfirm: {
    borderColor: '#ff5050',
    color: '#ff5050',
    background: 'rgba(255, 80, 80, 0.1)',
  },
  startBtn: {
    padding: '14px 24px',
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    color: 'white',
    borderWidth: '0',
    borderStyle: 'none',
    borderRadius: '12px',
    fontSize: '16px',
    cursor: 'pointer',
    fontFamily: '"Noto Serif SC", serif',
    textAlign: 'center' as const,
    marginTop: '12px',
  },
  startBtnSub: {
    fontSize: '12px',
    opacity: 0.8,
  },
};
