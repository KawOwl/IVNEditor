/**
 * CharacterPanel - Collapsible left-side panel showing character info and actions.
 * Displays persona details, personality traits, current goal, and GOAP action library.
 */

import { useState } from 'react';
import { useCharacterStore } from '../memory/character-store';
import { useDebugStore } from '../debug/debug-store';
import type { GOAPAction } from '../memory/schemas';
import { T } from '../theme';

interface CharacterPanelProps {
  characterId: string;
  goapActions: GOAPAction[];
}

export function CharacterPanel({ characterId, goapActions }: CharacterPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    persona: true,
    traits: true,
    goals: true,
    actions: false,
  });

  const character = useCharacterStore((s) => s.characters[characterId]);
  const currentGoal = useDebugStore((s) => s.currentGoal);

  const persona = character?.core;
  const goals = character
    ? { longTerm: character.longTermGoals, shortTerm: character.shortTermGoals }
    : { longTerm: [], shortTerm: [] };

  const toggleSection = (key: string) =>
    setExpandedSections((s) => ({ ...s, [key]: !s[key] }));

  if (!persona) return null;

  // Collapsed state
  if (!expanded) {
    return (
      <div style={styles.collapsed} onClick={() => setExpanded(true)}>
        <span style={styles.collapsedInitial}>{persona.name.charAt(0)}</span>
        <span style={styles.collapsedLabel}>角色 ▸</span>
      </div>
    );
  }

  // Count dynamic (runtime-generated) actions
  const scriptActionCount = goapActions.filter((a) => !a.id.startsWith('dyn-')).length;
  const dynamicActionCount = goapActions.length - scriptActionCount;

  return (
    <aside style={styles.panel}>
      {/* Header */}
      <div style={styles.header}>
        <span style={styles.headerTitle}>{persona.name}</span>
        <button style={styles.collapseBtn} onClick={() => setExpanded(false)}>◂</button>
      </div>

      <div style={styles.scrollArea}>
        {/* Persona info */}
        <Section title="基本设定" sectionKey="persona" expanded={expandedSections.persona} toggle={toggleSection}>
          {persona.background && (
            <div style={styles.infoBlock}>
              <span style={styles.infoLabel}>背景</span>
              <p style={styles.infoText}>{persona.background}</p>
            </div>
          )}
          {persona.appearance && (
            <div style={styles.infoBlock}>
              <span style={styles.infoLabel}>外貌</span>
              <p style={styles.infoText}>{persona.appearance}</p>
            </div>
          )}
          <div style={styles.infoBlock}>
            <span style={styles.infoLabel}>说话风格</span>
            <p style={styles.infoText}>{persona.speechStyle}</p>
          </div>
          {persona.values.length > 0 && (
            <div style={styles.infoBlock}>
              <span style={styles.infoLabel}>价值观</span>
              <div style={styles.tagList}>
                {persona.values.map((v, i) => (
                  <span key={i} style={styles.tag}>{v}</span>
                ))}
              </div>
            </div>
          )}
        </Section>

        {/* Personality traits */}
        <Section title="性格特质" sectionKey="traits" expanded={expandedSections.traits} toggle={toggleSection}>
          {persona.personality.map((t, i) => (
            <div key={i} style={styles.traitRow}>
              <span style={styles.traitName}>{t.trait}</span>
              <div style={styles.traitBar}>
                <div
                  style={{
                    ...styles.traitFill,
                    width: `${Math.round(t.intensity * 100)}%`,
                  }}
                />
              </div>
              <span style={styles.traitValue}>{Math.round(t.intensity * 100)}%</span>
            </div>
          ))}
        </Section>

        {/* Current goal */}
        <Section title="当前目标" sectionKey="goals" expanded={expandedSections.goals} toggle={toggleSection}>
          {currentGoal ? (
            <div style={styles.goalCard}>
              <p style={styles.goalWhat}>{currentGoal.what}</p>
              <p style={styles.goalWhy}>{currentGoal.why}</p>
              <div style={styles.goalMeta}>
                <span>📍 {currentGoal.where}</span>
                {currentGoal.when && <span>⏰ {currentGoal.when}</span>}
              </div>
              {currentGoal.who.length > 0 && (
                <div style={styles.goalMeta}>
                  <span>👥 {currentGoal.who.join(', ')}</span>
                </div>
              )}
            </div>
          ) : (
            <p style={styles.emptyText}>等待推理...</p>
          )}
          {goals.longTerm.length > 0 && (
            <div style={styles.longTermBlock}>
              <span style={styles.infoLabel}>长期目标</span>
              {goals.longTerm.map((g, i) => (
                <div key={i} style={styles.longTermItem}>
                  <span style={styles.longTermPriority}>P{g.priority}</span>
                  <span style={styles.longTermDesc}>{g.description}</span>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* GOAP Actions */}
        <Section
          title={`动作库 (${goapActions.length})`}
          sectionKey="actions"
          expanded={expandedSections.actions}
          toggle={toggleSection}
        >
          {goapActions.map((action) => (
            <div key={action.id} style={styles.actionCard}>
              <div style={styles.actionHeader}>
                <span style={styles.actionName}>{action.name}</span>
                {action.id.startsWith('dyn-') && (
                  <span style={styles.dynamicBadge}>习得</span>
                )}
              </div>
              <p style={styles.actionDesc}>{action.description}</p>
              <div style={styles.actionMeta}>
                <span>⏱ {action.timeCost}m</span>
                <span>💰 {action.cost}</span>
              </div>
            </div>
          ))}
          {dynamicActionCount > 0 && (
            <p style={styles.dynamicNote}>
              其中 {dynamicActionCount} 个为运行时习得
            </p>
          )}
        </Section>
      </div>
    </aside>
  );
}

// ─── Section sub-component ──────────────────────────

function Section({
  title,
  sectionKey,
  expanded,
  toggle,
  children,
}: {
  title: string;
  sectionKey: string;
  expanded: boolean;
  toggle: (key: string) => void;
  children: React.ReactNode;
}) {
  return (
    <div style={styles.section}>
      <div style={styles.sectionHeader} onClick={() => toggle(sectionKey)}>
        <span>{expanded ? '▾' : '▸'} {title}</span>
      </div>
      {expanded && <div style={styles.sectionBody}>{children}</div>}
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  collapsed: {
    width: '32px',
    height: '100%',
    background: T.bgSurface,
    borderRight: `1px solid ${T.border}`,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    paddingTop: '12px',
    cursor: 'pointer',
    gap: '8px',
    flexShrink: 0,
  },
  collapsedInitial: {
    width: '24px',
    height: '24px',
    borderRadius: T.radiusPill,
    background: T.accent,
    color: 'white',
    fontSize: '12px',
    fontWeight: 'bold',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  collapsedLabel: {
    writingMode: 'vertical-rl',
    fontSize: '11px',
    color: T.textTertiary,
  },
  panel: {
    width: '280px',
    height: '100%',
    background: T.bgSurface,
    borderRight: `1px solid ${T.border}`,
    display: 'flex',
    flexDirection: 'column',
    fontSize: '12px',
    color: T.textSecondary,
    fontFamily: T.fontMono,
    flexShrink: 0,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 12px',
    background: T.bg,
    borderBottom: `1px solid ${T.border}`,
  },
  headerTitle: {
    fontWeight: 'bold',
    color: T.accent,
    fontSize: '13px',
  },
  collapseBtn: {
    background: 'none',
    borderWidth: '0',
    borderStyle: 'none',
    color: T.textTertiary,
    cursor: 'pointer',
    fontSize: '14px',
    padding: '2px 6px',
  },
  scrollArea: {
    flex: 1,
    overflowY: 'auto',
  },
  section: {
    borderBottom: `1px solid ${T.border}`,
  },
  sectionHeader: {
    padding: '6px 12px',
    background: T.bg,
    cursor: 'pointer',
    color: T.textSecondary,
    fontSize: '11px',
    fontWeight: 'bold',
  },
  sectionBody: {
    padding: '6px 12px 10px',
  },
  infoBlock: {
    marginBottom: '8px',
  },
  infoLabel: {
    color: T.textTertiary,
    fontSize: '10px',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
  },
  infoText: {
    margin: '2px 0 0',
    color: T.textSecondary,
    lineHeight: '1.5',
    fontSize: '11px',
  },
  tagList: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '4px',
    marginTop: '4px',
  },
  tag: {
    padding: '2px 8px',
    background: T.accentMuted,
    borderRadius: T.radiusPill,
    fontSize: '10px',
    color: T.accent,
  },
  traitRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '3px 0',
  },
  traitName: {
    width: '60px',
    flexShrink: 0,
    color: T.textSecondary,
    fontSize: '11px',
  },
  traitBar: {
    flex: 1,
    height: '4px',
    background: 'rgba(255,255,255,0.08)',
    borderRadius: T.radius,
    overflow: 'hidden',
  },
  traitFill: {
    height: '100%',
    background: `linear-gradient(90deg, ${T.accent}, ${T.gold})`,
    borderRadius: T.radius,
    transition: 'width 0.3s',
  },
  traitValue: {
    width: '32px',
    textAlign: 'right',
    color: T.textMuted,
    fontSize: '10px',
    flexShrink: 0,
  },
  goalCard: {
    background: T.accentMuted,
    borderRadius: T.radius,
    padding: '8px',
    marginBottom: '6px',
  },
  goalWhat: {
    margin: '0 0 4px',
    color: T.accent,
    fontWeight: 'bold',
    fontSize: '11px',
    lineHeight: '1.4',
  },
  goalWhy: {
    margin: '0 0 4px',
    color: T.textTertiary,
    fontSize: '10px',
    fontStyle: 'italic',
    lineHeight: '1.4',
  },
  goalMeta: {
    display: 'flex',
    gap: '8px',
    color: T.textTertiary,
    fontSize: '10px',
  },
  emptyText: {
    color: T.textMuted,
    fontStyle: 'italic',
    margin: '4px 0',
  },
  longTermBlock: {
    marginTop: '8px',
  },
  longTermItem: {
    display: 'flex',
    gap: '6px',
    padding: '2px 0',
    alignItems: 'baseline',
  },
  longTermPriority: {
    color: T.accent,
    fontSize: '10px',
    fontWeight: 'bold',
    flexShrink: 0,
  },
  longTermDesc: {
    color: T.textSecondary,
    fontSize: '11px',
    lineHeight: '1.4',
  },
  actionCard: {
    background: 'rgba(255,255,255,0.03)',
    borderRadius: T.radius,
    padding: '6px 8px',
    marginBottom: '4px',
  },
  actionHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  actionName: {
    color: T.success,
    fontSize: '11px',
    fontWeight: 'bold',
  },
  dynamicBadge: {
    padding: '1px 5px',
    background: T.accentMuted,
    borderRadius: T.radius,
    fontSize: '9px',
    color: T.accent,
  },
  actionDesc: {
    margin: '2px 0',
    color: T.textTertiary,
    fontSize: '10px',
    lineHeight: '1.3',
  },
  actionMeta: {
    display: 'flex',
    gap: '8px',
    color: T.textMuted,
    fontSize: '10px',
  },
  dynamicNote: {
    color: T.accent,
    fontSize: '10px',
    fontStyle: 'italic',
    marginTop: '4px',
  },
};
