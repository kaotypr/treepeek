import { useQuery } from "@tanstack/react-query";
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
    return result.ok ? null : result.error.message;
  };
  return { settings: latest ?? initial.data ?? null, save };
}
