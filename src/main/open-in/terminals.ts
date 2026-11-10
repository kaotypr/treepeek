import type { DetectedApp } from "../../shared/ipc/contract";
import type { AppChoice } from "../../shared/settings";
import { type DetectDeps, detectApps, type KnownApp } from "./detect";
import { OPEN } from "./editors";
import { type Launch, templateLaunch } from "./template";

/** The terminals Treepeek detects. Each opens a new window at a folder given to `open`. */
export const KNOWN_TERMINALS: readonly KnownApp[] = Object.freeze([
  { name: "Terminal", bundleId: "com.apple.Terminal", appNames: ["Utilities/Terminal.app"] },
  { name: "iTerm2", bundleId: "com.googlecode.iterm2", appNames: ["iTerm.app"] },
  { name: "Ghostty", bundleId: "com.mitchellh.ghostty", appNames: ["Ghostty.app"] },
  { name: "Warp", bundleId: "dev.warp.Warp-Stable", appNames: ["Warp.app"] },
]);

/** "Automatic" opens Terminal, which every Mac has. */
export const DEFAULT_TERMINAL = "com.apple.Terminal";

export function detectTerminals(deps: DetectDeps): Promise<DetectedApp[]> {
  return detectApps(KNOWN_TERMINALS, deps);
}

/**
 * What opening a terminal at `dir` runs: `open -b <bundleId> <dir>`, or the custom command
 * expanded without a shell. `dir` must be a folder; main checks that first, because a
 * terminal handed a file runs it.
 */
export function terminalLaunch(setting: AppChoice, dir: string): Launch {
  if (setting.kind === "custom") return templateLaunch(setting.command, { path: dir });
  const bundleId = setting.kind === "app" ? setting.bundleId : DEFAULT_TERMINAL;
  return { command: OPEN, args: ["-b", bundleId, dir] };
}
