import type { Logger } from "../shared/log";

/** The part of Electron's `powerMonitor` this needs; tests pass a stand-in. */
export interface PowerEvents {
  on(event: "resume", listener: () => void): unknown;
  off(event: "resume", listener: () => void): unknown;
}

/**
 * Tells the core service when the Mac wakes from sleep (`powerMonitor` `resume`), so live
 * refresh reads every window's checkouts again: FSEvents may have dropped events while it
 * slept. Returns a function that stops forwarding.
 */
export function forwardPowerResume(
  power: PowerEvents,
  notify: () => void,
  log: Logger,
): () => void {
  const onResume = () => {
    log.info("the Mac woke from sleep; asking the core service to check the scans again");
    notify();
  };
  power.on("resume", onResume);
  return () => {
    power.off("resume", onResume);
  };
}
