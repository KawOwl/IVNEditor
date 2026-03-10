/**
 * Debug Drawer - Right-side panel showing real-time core loop state.
 */

import { useState } from 'react';
import { useDebugStore } from './debug-store';
import type { GamePhase } from './debug-store';

const phaseLabels: Record<GamePhase, string> = {
  idle: '⏸ 空闲',
  assemble: '① 上下文组装',
  cognition: '② 5W1H推理',
  goap: '③ GOAP规划',
  goap_gen: '②½ 动态动作生成',
  timeline: '④ 时间线检测',
  director: '⑤ 叙事生成',
  render: '⑥ 渲染中',
  reflection: '⑩ 记忆反思',
  waiting_input: '⑦ 等待输入',
  error: '❌ 错误',
};

const phaseColors: Record<GamePhase, string> = {
  idle: '#666',
  assemble: '#7ec8e3',
  cognition: '#e6c3a1',
  goap: '#a1e6c3',
  goap_gen: '#b8e6a1',
  timeline: '#e6a1c3',
  director: '#c3a1e6',
  render: '#a1c3e6',
  reflection: '#e6e6a1',
  waiting_input: '#c3e6a1',
  error: '#e64545',
};

export function DebugDrawer() {
  const state = useDebugStore();
  const [collapsed, setCollapsed] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    phase: true,
    goal: true,
    goap: true,
    memory: false,
    timeline: true,
    traces: true,
    errors: false,
  });

  const toggle = (section: string) =>
    setExpandedSections((s) => ({ ...s, [section]: !s[section] }));

  if (collapsed) {
    return (
      <div style={styles.collapsedBar} onClick={() => setCollapsed(false)}>
        <span style={{ ...styles.phaseDot, background: phaseColors[state.phase] }} />
        <span style={styles.collapsedLabel}>Debug ▸</span>
      </div>
    );
  }

  const elapsed = state.phaseStartedAt > 0
    ? ((Date.now() - state.phaseStartedAt) / 1000).toFixed(1)
    : '0.0';

  return (
    <aside style={styles.drawer}>
      {/* Header */}
      <div style={styles.drawerHeader}>
        <span style={styles.drawerTitle}>Debug Panel</span>
        <span style={styles.loopCount}>Loop #{state.loopCount}</span>
        <button style={styles.collapseBtn} onClick={() => setCollapsed(true)}>◂</button>
      </div>

      <div style={styles.scrollArea}>
        {/* Phase */}
        <Section title="核心循环状态" section="phase" expanded={expandedSections.phase} toggle={toggle}>
          <div style={styles.phaseBox}>
            <span style={{ ...styles.phaseDot, background: phaseColors[state.phase] }} />
            <span style={styles.phaseLabel}>{phaseLabels[state.phase]}</span>
            <span style={styles.elapsed}>{elapsed}s</span>
          </div>
        </Section>

        {/* 5W1H Goal */}
        <Section title="5W1H目标" section="goal" expanded={expandedSections.goal} toggle={toggle}>
          {state.currentGoal ? (
            <div style={styles.goalBox}>
              <Row label="What" value={state.currentGoal.what} />
              <Row label="Why" value={state.currentGoal.why} />
              <Row label="Where" value={state.currentGoal.where} />
              <Row label="When" value={state.currentGoal.when} />
              <Row label="Who" value={state.currentGoal.who.join(', ')} />
              <Row label="How" value={state.currentGoal.how.join(' → ')} />
            </div>
          ) : (
            <div style={styles.empty}>等待推理...</div>
          )}
        </Section>

        {/* GOAP Queue */}
        <Section title="GOAP行动队列" section="goap" expanded={expandedSections.goap} toggle={toggle}>
          {state.goapQueue.length > 0 ? (
            <div>
              {state.goapQueue.map((item, i) => (
                <div key={i} style={styles.goapItem}>
                  <span style={styles.goapIcon}>
                    {item.status === 'done' ? '✅' : item.status === 'running' ? '⏳' : item.status === 'interrupted' ? '⚠️' : '○'}
                  </span>
                  <span style={styles.goapName}>{item.action.name}</span>
                  <span style={styles.goapTime}>{item.action.timeCost}m</span>
                </div>
              ))}
              <div style={styles.goapTotal}>
                总耗时：{state.goapTotalTime}分钟
              </div>
            </div>
          ) : (
            <div style={styles.empty}>无行动计划</div>
          )}
        </Section>

        {/* Memory Context */}
        <Section title="记忆上下文" section="memory" expanded={expandedSections.memory} toggle={toggle}>
          <Row label="召回记忆" value={`${state.memoryContext.recalledCount}条`} />
          <Row label="Token数" value={state.memoryContext.totalTokens.toLocaleString()} />
          <Row label="人格补丁" value={`${state.memoryContext.personaShiftCount}条`} />
          {state.memoryContext.recalledItems.length > 0 && (
            <div style={styles.memoryList}>
              {state.memoryContext.recalledItems.map((m, i) => (
                <div key={i} style={styles.memoryItem}>
                  <span style={styles.memoryType}>[{m.type}]</span>
                  <span style={styles.memoryContent}>
                    {m.content.length > 60 ? m.content.slice(0, 60) + '...' : m.content}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* Timeline */}
        <Section title="时间线" section="timeline" expanded={expandedSections.timeline} toggle={toggle}>
          <Row label="当前时间" value={state.timeline.currentTime} />
          {state.timeline.goalEndTime && (
            <Row label="目标结束" value={state.timeline.goalEndTime} />
          )}
          {state.timeline.upcomingEvents.length > 0 && (
            <div style={styles.eventList}>
              {state.timeline.upcomingEvents.map((e, i) => (
                <div
                  key={i}
                  style={{
                    ...styles.eventItem,
                    color: e.conflict ? '#e64545' : '#aaa',
                  }}
                >
                  {e.conflict ? '⚠' : '•'} {e.time} {e.event}
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* Agent Traces */}
        <Section title="Agent Trace" section="traces" expanded={expandedSections.traces} toggle={toggle}>
          {state.traces.length > 0 ? (
            <div>
              {state.traces.slice(-5).reverse().map((t, i) => (
                <div key={i} style={styles.traceItem}>
                  <span style={styles.traceAgent}>{t.agent}</span>
                  <span style={styles.traceDuration}>{(t.duration / 1000).toFixed(1)}s</span>
                  <span style={styles.traceTokens}>
                    {t.inputTokens + t.outputTokens} tok
                  </span>
                </div>
              ))}
              <div style={styles.traceTotal}>
                总Token：{state.traces.reduce((sum, t) => sum + t.inputTokens + t.outputTokens, 0).toLocaleString()}
              </div>
            </div>
          ) : (
            <div style={styles.empty}>无trace数据</div>
          )}
        </Section>

        {/* Errors */}
        {state.errors.length > 0 && (
          <Section title="错误日志" section="errors" expanded={expandedSections.errors} toggle={toggle}>
            {state.errors.map((e, i) => (
              <div key={i} style={styles.errorItem}>
                {new Date(e.timestamp).toLocaleTimeString()} - {e.message}
              </div>
            ))}
          </Section>
        )}
      </div>
    </aside>
  );
}

// ─── Sub-components ──────────────────────────────────────

function Section({
  title,
  section,
  expanded,
  toggle,
  children,
}: {
  title: string;
  section: string;
  expanded: boolean;
  toggle: (s: string) => void;
  children: React.ReactNode;
}) {
  return (
    <div style={styles.section}>
      <div style={styles.sectionHeader} onClick={() => toggle(section)}>
        <span>{expanded ? '▾' : '▸'} {title}</span>
      </div>
      {expanded && <div style={styles.sectionBody}>{children}</div>}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={styles.row}>
      <span style={styles.rowLabel}>{label}</span>
      <span style={styles.rowValue}>{value}</span>
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  drawer: {
    width: '320px',
    height: '100%',
    background: '#1e1e2e',
    borderLeft: '1px solid #333',
    display: 'flex',
    flexDirection: 'column',
    fontSize: '12px',
    color: '#ccc',
    fontFamily: '"JetBrains Mono", "Fira Code", monospace',
    flexShrink: 0,
  },
  drawerHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 12px',
    background: '#181825',
    borderBottom: '1px solid #333',
  },
  drawerTitle: { fontWeight: 'bold', color: '#cdd6f4' },
  loopCount: { color: '#7ec8e3', fontSize: '11px' },
  collapseBtn: {
    background: 'none',
    borderWidth: '0',
    borderStyle: 'none',
    color: '#888',
    cursor: 'pointer',
    fontSize: '14px',
    padding: '2px 6px',
  },
  scrollArea: {
    flex: 1,
    overflowY: 'auto',
  },
  collapsedBar: {
    width: '32px',
    height: '100%',
    background: '#1e1e2e',
    borderLeft: '1px solid #333',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    paddingTop: '12px',
    cursor: 'pointer',
    gap: '8px',
  },
  collapsedLabel: {
    writingMode: 'vertical-rl',
    fontSize: '11px',
    color: '#888',
  },
  section: {
    borderBottom: '1px solid #2a2a3a',
  },
  sectionHeader: {
    padding: '6px 12px',
    background: '#181825',
    cursor: 'pointer',
    color: '#bac2de',
    fontSize: '11px',
    fontWeight: 'bold',
  },
  sectionBody: {
    padding: '6px 12px 10px',
  },
  phaseBox: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  phaseDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    display: 'inline-block',
    flexShrink: 0,
  },
  phaseLabel: { flex: 1 },
  elapsed: { color: '#7ec8e3' },
  goalBox: {},
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '2px 0',
    gap: '8px',
  },
  rowLabel: { color: '#888', flexShrink: 0 },
  rowValue: { textAlign: 'right', wordBreak: 'break-all' },
  empty: { color: '#555', fontStyle: 'italic', padding: '4px 0' },
  goapItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '2px 0',
  },
  goapIcon: { fontSize: '12px', width: '18px', textAlign: 'center' },
  goapName: { flex: 1 },
  goapTime: { color: '#888' },
  goapTotal: { color: '#7ec8e3', marginTop: '4px', fontSize: '11px' },
  memoryList: { marginTop: '4px' },
  memoryItem: {
    padding: '2px 0',
    fontSize: '11px',
    lineHeight: '1.4',
  },
  memoryType: { color: '#c3a76e', marginRight: '4px' },
  memoryContent: { color: '#999' },
  eventList: { marginTop: '4px' },
  eventItem: {
    padding: '2px 0',
    fontSize: '11px',
  },
  traceItem: {
    display: 'flex',
    gap: '8px',
    padding: '2px 0',
  },
  traceAgent: { color: '#c3a1e6', flex: 1 },
  traceDuration: { color: '#a1e6c3' },
  traceTokens: { color: '#888' },
  traceTotal: { color: '#7ec8e3', marginTop: '4px', fontSize: '11px' },
  errorItem: {
    color: '#e64545',
    padding: '2px 0',
    fontSize: '11px',
    lineHeight: '1.4',
  },
};
