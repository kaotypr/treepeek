import type { Session, SessionServices } from "../sessions/session";
import { registerCompareHandlers } from "./compare";
import { registerDiffHandlers } from "./diff";
import { registerScanHandlers } from "./scan";
import { registerSessionHandlers } from "./session";
import { registerStartHandlers } from "./start";

/** Installs the session, scan, start-override, comparison and diff handlers on a new session. */
export function registerSessionCalls(session: Session, services: SessionServices): void {
  registerSessionHandlers(session);
  registerScanHandlers(session);
  registerStartHandlers(session, services);
  registerCompareHandlers(session);
  registerDiffHandlers(session);
}
