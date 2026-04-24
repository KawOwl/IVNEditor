import { useCallback, useState } from 'react';

const LS_PLAYTEST_LLM_KEY = 'ivn-editor-playtest-llm-config-id';

export function usePlaytestLlmConfigId() {
  const [playtestLlmConfigId, setPlaytestLlmConfigIdState] = useState<string | null>(
    () => {
      try {
        return localStorage.getItem(LS_PLAYTEST_LLM_KEY);
      } catch {
        return null;
      }
    },
  );

  const setPlaytestLlmConfigId = useCallback((id: string | null) => {
    try {
      if (id) localStorage.setItem(LS_PLAYTEST_LLM_KEY, id);
      else localStorage.removeItem(LS_PLAYTEST_LLM_KEY);
    } catch {
      // ignore
    }
    setPlaytestLlmConfigIdState(id);
  }, []);

  return [playtestLlmConfigId, setPlaytestLlmConfigId] as const;
}
