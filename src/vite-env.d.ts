/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ENGINE_MODE?: 'local' | 'remote';
  readonly VITE_BACKEND_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
