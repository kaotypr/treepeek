import { Welcome } from "../screens/welcome/Welcome";
import { Providers } from "./providers";
import { ScanWindow } from "./ScanWindow";
import { useWindowInfo } from "./window-info";

/**
 * The window's content: the welcome window, or the scan window for one folder. Main says
 * which right after the page loads; until then the window shows its background only.
 */
export function App() {
  const info = useWindowInfo();
  return (
    <Providers>
      {info === null ? (
        <div className="h-full" />
      ) : info.scanRoot === null ? (
        <Welcome />
      ) : (
        <ScanWindow scanRoot={info.scanRoot} />
      )}
    </Providers>
  );
}
