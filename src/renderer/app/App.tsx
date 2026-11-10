import { useEffect } from "react";
import { installMenuCommands, useCommand } from "../commands/registry";
import { main } from "../data/client";
import { About } from "../screens/about/About";
import { SettingsWindow } from "../screens/settings/SettingsWindow";
import { Welcome } from "../screens/welcome/Welcome";
import { Providers } from "./providers";
import { ScanWindow } from "./ScanWindow";
import { useWindowInfo, type WindowInfo } from "./window-info";

/**
 * The window's content: the welcome window, the scan window for one folder, Settings or
 * About. Main says which right after the page loads; until then the window shows its
 * background only.
 */
export function App() {
  const info = useWindowInfo();
  useEffect(() => installMenuCommands(), []);
  useCommand("app.settings", () => void main().settings.open({}));
  return <Providers>{content(info)}</Providers>;
}

function content(info: WindowInfo | null) {
  if (info === null) return <div className="h-full" />;
  switch (info.kind) {
    case "settings":
      return <SettingsWindow />;
    case "about":
      return <About />;
    case "welcome":
      return <Welcome />;
    case "scan":
      return info.scanRoot === null ? <Welcome /> : <ScanWindow scanRoot={info.scanRoot} />;
  }
}
