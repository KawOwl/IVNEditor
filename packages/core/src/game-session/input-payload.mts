/**
 * 根据玩家输入 + 当前挂起的 choices 算 player_input entry 的结构化 payload。
 */
export function computeReceivePayload(
  text: string,
  choices: string[] | null,
): { inputType: 'choice' | 'freetext'; selectedIndex?: number } {
  if (!choices || choices.length === 0) {
    return { inputType: 'freetext' };
  }

  const idx = choices.indexOf(text);
  if (idx >= 0) {
    return { inputType: 'choice', selectedIndex: idx };
  }

  return { inputType: 'freetext' };
}
