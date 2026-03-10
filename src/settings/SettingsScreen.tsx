/**
 * SettingsScreen — Main settings container with tab navigation.
 * Tabs: 选择剧本 / 上传剧本 / 生成剧本
 */

import { useSettingsStore, type SettingsTab } from './settings-store';
import { ScriptList } from './ScriptList';
import { ScriptUpload } from './ScriptUpload';
import { ScriptGenerator } from './ScriptGenerator';
import { ModelConfigPanel } from './ModelConfig';

interface SettingsScreenProps {
  onBack: () => void;
  onStartGame: () => void;
}

const tabs: { key: SettingsTab; label: string }[] = [
  { key: 'select', label: '📚 选择剧本' },
  { key: 'upload', label: '📤 上传剧本' },
  { key: 'generate', label: '✨ 生成剧本' },
  { key: 'model', label: '🔧 模型配置' },
];

export function SettingsScreen({ onBack, onStartGame }: SettingsScreenProps) {
  const currentTab = useSettingsStore((s) => s.currentTab);
  const setTab = useSettingsStore((s) => s.setTab);
  const error = useSettingsStore((s) => s.error);

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <button style={styles.backBtn} onClick={onBack}>
          ← 返回
        </button>
        <h2 style={styles.title}>设置</h2>
        <div style={{ width: 60 }} /> {/* spacer for centering */}
      </div>

      {/* Tab bar */}
      <div style={styles.tabBar}>
        {tabs.map((tab) => (
          <button
            key={tab.key}
            style={{
              ...styles.tabBtn,
              ...(currentTab === tab.key ? styles.tabBtnActive : {}),
            }}
            onClick={() => setTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Error display */}
      {error && (
        <div style={styles.errorBar}>
          {error}
        </div>
      )}

      {/* Content */}
      <div style={styles.content}>
        {currentTab === 'select' && (
          <ScriptList onStartGame={onStartGame} />
        )}
        {currentTab === 'upload' && <ScriptUpload />}
        {currentTab === 'generate' && <ScriptGenerator />}
        {currentTab === 'model' && <ModelConfigPanel />}
      </div>
    </div>
  );
}

// ─── Styles ────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  container: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    background: 'linear-gradient(180deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px 20px',
    borderBottom: '1px solid rgba(255,255,255,0.1)',
  },
  backBtn: {
    padding: '6px 12px',
    background: 'rgba(255,255,255,0.06)',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'rgba(255,255,255,0.15)',
    borderRadius: '6px',
    color: '#7ec8e3',
    fontSize: '13px',
    cursor: 'pointer',
  },
  title: {
    color: '#e6c3a1',
    fontSize: '18px',
    fontFamily: '"Noto Serif SC", serif',
    margin: 0,
  },
  tabBar: {
    display: 'flex',
    gap: '4px',
    padding: '12px 20px',
    borderBottom: '1px solid rgba(255,255,255,0.06)',
  },
  tabBtn: {
    flex: 1,
    padding: '8px 12px',
    background: 'rgba(255,255,255,0.04)',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: '6px',
    color: '#888',
    fontSize: '12px',
    cursor: 'pointer',
    textAlign: 'center' as const,
  },
  tabBtnActive: {
    background: 'rgba(102, 126, 234, 0.2)',
    borderColor: '#667eea',
    color: '#7ec8e3',
  },
  errorBar: {
    margin: '8px 20px 0',
    padding: '8px 12px',
    background: 'rgba(255, 80, 80, 0.15)',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'rgba(255, 80, 80, 0.3)',
    borderRadius: '6px',
    color: '#ff8888',
    fontSize: '12px',
  },
  content: {
    flex: 1,
    overflow: 'auto',
    padding: '16px 20px',
  },
};
