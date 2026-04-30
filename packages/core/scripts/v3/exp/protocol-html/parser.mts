import { parseDocument, ElementType } from 'htmlparser2';
import type { ChildNode, Element } from 'domhandler';
import { isTag } from 'domhandler';

import type {
  ChoicesBlock,
  NarrativeUnit,
  ParseResult,
  StateUpdate,
} from './types.mts';

// domhandler.isTag 涵盖 ElementType.Tag / Script / Style 三类（都是 Element
// instances）。<script> / <style> 的 type 是 'script' / 'style' 不是 'tag'，
// 单看 ElementType.Tag 会漏。
const isElement = (n: ChildNode): n is Element => isTag(n);

const textOf = (el: Element): string => {
  let acc = '';
  for (const c of el.children) {
    if (c.type === ElementType.Text) acc += (c as { data: string }).data;
    else if (isElement(c)) acc += textOf(c);
  }
  return acc.trim();
};

const attribOf = (el: Element, key: string): string | undefined =>
  el.attribs[key];

const LEGACY_TAGS: ReadonlySet<string> = new Set([
  'narration',
  'dialogue',
  'sprite',
  'stage',
  'background',
  'scratch',
]);

// Buffered parser：一次性吞 html 文本，返回 ParseResult。
// htmlparser2 lenient mode（默认），未闭合 / 异常嵌套不会抛错。
export const parseHtmlProtocol = (html: string): ParseResult => {
  const doc = parseDocument(html);
  const units: NarrativeUnit[] = [];
  const warnings: string[] = [];
  let choices: ChoicesBlock | null = null;
  let stateUpdate: StateUpdate | null = null;

  const walk = (nodes: readonly ChildNode[]): void => {
    for (const n of nodes) {
      if (!isElement(n)) continue;
      const name = n.name.toLowerCase();

      if (name === 'p') {
        const speaker = attribOf(n, 'data-speaker');
        const text = textOf(n);
        if (text.length === 0) continue;
        units.push(
          speaker
            ? { kind: 'dialogue', speaker, text }
            : { kind: 'narration', text },
        );
      } else if (name === 'div') {
        const kind = attribOf(n, 'data-kind');
        const bg = attribOf(n, 'data-bg');
        const sprite = attribOf(n, 'data-sprite');
        if (kind === 'scratch') {
          const text = textOf(n);
          if (text.length > 0) units.push({ kind: 'scratch', text });
        } else if (bg !== undefined) {
          units.push({ kind: 'background', bg, text: textOf(n) });
        } else if (sprite !== undefined) {
          const segs = sprite.split('/');
          const char = segs[0] ?? sprite;
          const mood = segs[1];
          const position = segs[2];
          units.push({ kind: 'sprite', char, mood, position, text: textOf(n) });
        } else {
          // 裸 <div> 当容器，递归子节点继续抽
          walk(n.children as ChildNode[]);
        }
      } else if (name === 'ul' && attribOf(n, 'data-input') === 'choices') {
        const items = n.children
          .filter(isElement)
          .filter((c) => c.name.toLowerCase() === 'li');
        const options = items.map((c) => textOf(c)).filter((t) => t.length > 0);
        if (options.length === 0) {
          warnings.push(`<ul data-input="choices"> 空选项`);
        } else if (choices !== null) {
          warnings.push(`重复 <ul data-input="choices">，仅取第一组`);
        } else {
          choices = { options };
        }
      } else if (
        name === 'script' &&
        attribOf(n, 'type') === 'application/x-state'
      ) {
        const text = textOf(n);
        if (stateUpdate !== null) {
          warnings.push(
            `重复 <script type="application/x-state">，仅取第一组`,
          );
        } else {
          try {
            const parsed = JSON.parse(text);
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
              warnings.push(
                `<script application/x-state> 内容必须是对象，得到 ${typeof parsed}`,
              );
            } else {
              stateUpdate = parsed as StateUpdate;
            }
          } catch (e) {
            warnings.push(
              `<script application/x-state> JSON parse 失败: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
      } else if (LEGACY_TAGS.has(name)) {
        warnings.push(
          `legacy IVN tag <${name}> 出现 —— 应换 HTML 形态（<p data-speaker> / <aside data-kind="scratch"> / <figure data-bg|data-sprite>）`,
        );
      }
      // 其他未知 tag 静默吞，不进 warnings（避免 LLM 偶发装饰性 <span> / <em> 噪音）
    }
  };

  walk(doc.children as ChildNode[]);
  return { units, choices, stateUpdate, warnings };
};
