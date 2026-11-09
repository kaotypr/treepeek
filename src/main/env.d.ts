/** The compile-time values electron-vite puts on `import.meta.env` in the main build. */
interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
