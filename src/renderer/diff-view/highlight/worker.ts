/**
 * The syntax-highlighting worker: Shiki through `@pierre/diffs`' worker protocol, with the
 * JavaScript regex engine (no WebAssembly, so the CSP needs no `wasm-unsafe-eval`).
 * Grammars and themes are sent from the page, which loads them lazily from the app bundle.
 */
import "@pierre/diffs/worker/worker.js";
