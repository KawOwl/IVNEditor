// IVN v3 HTML 协议类型。
// 实验阶段：parse 结果 = 把 LLM emit 的 HTML 拆成业务可用的离散单元。

export type NarrativeUnit =
  | { readonly kind: 'narration'; readonly text: string }
  | { readonly kind: 'dialogue'; readonly speaker: string; readonly text: string }
  | { readonly kind: 'scratch'; readonly text: string }
  | { readonly kind: 'background'; readonly bg: string; readonly text: string }
  | {
      readonly kind: 'sprite';
      readonly char: string;
      readonly mood?: string;
      readonly position?: string;
      readonly text: string;
    };

export type ChoicesBlock = {
  readonly options: readonly string[];
};

export type StateUpdate = Readonly<Record<string, unknown>>;

export type ParseResult = {
  readonly units: readonly NarrativeUnit[];
  readonly choices: ChoicesBlock | null;
  readonly stateUpdate: StateUpdate | null;
  readonly warnings: readonly string[];
};
