/**
 * Development pages exist in `bun run dev` and in the lab build
 * (`electron-vite build --mode lab`, into `out-lab/`), never in `bun run build`. Both
 * values are compile-time constants, so a production build drops the lab code entirely.
 */
export const LAB_ENABLED: boolean = import.meta.env.DEV || import.meta.env.MODE === "lab";

/** The location hash that opens the diff lab. */
export const DIFF_LAB_HASH = "#diff-lab";
