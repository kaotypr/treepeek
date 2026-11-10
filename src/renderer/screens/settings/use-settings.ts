import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { Settings, SettingsPatch } from "../../../shared/settings";
import { main, unwrap } from "../../data/client";
import { useLatestEvent } from "../../data/events";

/**
 * The settings now (main sends `settings.changed` after every change, from any window),
 * and `save`, which answers why a change was refused, or `null` once it is saved.
 */
export function useSettings(): {
  settings: Settings | null;
  save: (patch: SettingsPatch) => Promise<string | null>;
} {
  const latest = useLatestEvent("settings.changed");
  const initial = useQuery({
    queryKey: ["settings"],
    queryFn: async () => unwrap(await main().settings.get()),
  });
  const save = async (patch: SettingsPatch) => {
    const result = await main().settings.set(patch);
    if (result.ok) return null;
    return result.error.code === "invalidRequest"
      ? (firstIssue(result.error.detail) ?? result.error.message)
      : result.error.message;
  };
  return { settings: latest ?? initial.data ?? null, save };
}

/**
 * A control's value: what was just chosen, at once, until the saved settings come back
 * with it (or with what main kept instead).
 */
export function useChoice<T>(saved: T): [T, (value: T) => void] {
  const [value, setValue] = useState(saved);
  useEffect(() => setValue(saved), [saved]);
  return [value, setValue];
}

/** The first message of Valibot's flattened issues (`{root, nested, other}`), if any. */
function firstIssue(detail: unknown): string | null {
  if (detail === null || typeof detail !== "object") return null;
  for (const group of Object.values(detail)) {
    const messages = Array.isArray(group)
      ? group
      : group && typeof group === "object"
        ? Object.values(group).flat()
        : [];
    const message = messages.find((item): item is string => typeof item === "string");
    if (message) return message;
  }
  return null;
}
