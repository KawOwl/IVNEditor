// IVN v3 HTML 协议类型。
// 实验阶段：parse 结果 = 把 LLM emit 的 HTML 拆成业务可用的离散 frames + 信号。

// ──────────────────────────────────────────────────────────
// ParticipationFrame —— 对话参与框架（参考 v2 IVN spec 与 owlet-in-shadow
// "参与框架"语义）。
// ──────────────────────────────────────────────────────────

export type ParticipationFrame = {
  readonly speaker: string;                      // 说话人 id
  readonly to?: string;                           // 受话者 id（addressee）
  readonly hear?: readonly string[];              // 在场旁听者 ids（intentional overhearers / witnesses）
  readonly eavesdroppers?: readonly string[];    // 偷听者 ids（unintended overhearers）
};

// ──────────────────────────────────────────────────────────
// SpriteSpec —— 立绘三段式 char/mood/position
// ──────────────────────────────────────────────────────────

export type SpriteSpec = {
  readonly char: string;
  readonly mood?: string;
  readonly position?: string;
};

// ──────────────────────────────────────────────────────────
// Frame —— 每个 <p> 是一帧。可附视觉切换；视觉默认继承上帧。
// data-cg 与 data-bg / data-sprite 互斥。
// ──────────────────────────────────────────────────────────

type FrameVisuals = {
  readonly bg?: string;
  readonly sprite?: SpriteSpec;
  readonly cg?: string;
};

export type Frame =
  | ({ readonly kind: 'narration'; readonly text: string } & FrameVisuals)
  | ({
      readonly kind: 'dialogue';
      readonly pf: ParticipationFrame;
      readonly text: string;
    } & FrameVisuals);

// ──────────────────────────────────────────────────────────
// 互动 + 状态信号
// ──────────────────────────────────────────────────────────

export type ChoicesBlock = {
  readonly options: readonly string[];
};

export type StateUpdate = Readonly<Record<string, unknown>>;

// ──────────────────────────────────────────────────────────
// ParseResult
// ──────────────────────────────────────────────────────────

export type ParseResult = {
  readonly frames: readonly Frame[];           // 每个 <p> 一帧
  readonly scratches: readonly string[];       // 元思考（<div data-kind="scratch">），不算帧
  readonly choices: ChoicesBlock | null;
  readonly stateUpdate: StateUpdate | null;
  readonly warnings: readonly string[];
};
