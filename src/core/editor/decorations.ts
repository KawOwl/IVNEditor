/**
 * Script Decorations — {{tool:xxx}} / {{state:xxx}} / {{segment:xxx}} 内联标签
 *
 * 使用 CodeMirror 6 的 MatchDecorator + ViewPlugin，
 * 将 {{type:name}} 标记渲染为彩色内联标签。
 *
 * 纯逻辑模块，不依赖 React。
 */

import {
  Decoration,
  type DecorationSet,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';

// ============================================================================
// Tag Widget — 内联标签 DOM 元素
// ============================================================================

type TagType = 'tool' | 'state' | 'segment';

const TAG_COLORS: Record<TagType, { bg: string; text: string; border: string }> = {
  tool:    { bg: '#1e3a5f', text: '#60a5fa', border: '#2563eb40' },
  state:   { bg: '#14532d', text: '#4ade80', border: '#16a34a40' },
  segment: { bg: '#422006', text: '#fbbf24', border: '#d9770640' },
};

const TAG_ICONS: Record<TagType, string> = {
  tool:    '⚙',
  state:   '◆',
  segment: '◧',
};

class TagWidget extends WidgetType {
  constructor(
    readonly tagType: TagType,
    readonly name: string,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const colors = TAG_COLORS[this.tagType];
    const icon = TAG_ICONS[this.tagType];

    const span = document.createElement('span');
    span.className = 'cm-script-tag';
    span.setAttribute('data-tag-type', this.tagType);
    span.setAttribute('data-tag-name', this.name);
    span.style.cssText = `
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 1px 6px;
      margin: 0 1px;
      border-radius: 4px;
      font-size: 12px;
      font-family: "Geist Mono", "SF Mono", monospace;
      line-height: 1.4;
      vertical-align: baseline;
      background: ${colors.bg};
      color: ${colors.text};
      border: 1px solid ${colors.border};
      cursor: default;
    `;

    span.textContent = `${icon} ${this.name}`;
    return span;
  }

  eq(other: TagWidget): boolean {
    return this.tagType === other.tagType && this.name === other.name;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

// ============================================================================
// Match Decorator — 匹配 {{type:name}} 模式
// ============================================================================

const TAG_REGEX = /\{\{(tool|state|segment):(\w+)\}\}/g;

const tagMatcher = new MatchDecorator({
  regexp: TAG_REGEX,
  decoration: (match, _view, _pos) => {
    const tagType = match[1] as TagType;
    const name = match[2]!;
    return Decoration.replace({
      widget: new TagWidget(tagType, name),
      inclusive: false,
    });
  },
});

// ============================================================================
// View Plugin — 管理装饰生命周期
// ============================================================================

const tagDecoPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = tagMatcher.createDeco(view);
    }

    update(update: ViewUpdate) {
      this.decorations = tagMatcher.updateDeco(update, this.decorations);
    }
  },
  {
    decorations: (v) => v.decorations,
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => {
        const value = view.plugin(plugin);
        return value?.decorations ?? Decoration.none;
      }),
  },
);

// ============================================================================
// Mark Decoration fallback — 光标在标签内时显示原始文本但加颜色
// ============================================================================

const tagMarkTheme = EditorView.baseTheme({
  '.cm-script-tag': {
    transition: 'all 0.15s ease',
  },
});

// ============================================================================
// Export — 组合扩展
// ============================================================================

/**
 * CodeMirror extension that renders {{tool:xxx}}, {{state:xxx}}, {{segment:xxx}}
 * as colored inline tag widgets.
 */
export function scriptTagDecorations() {
  return [tagDecoPlugin, tagMarkTheme];
}
