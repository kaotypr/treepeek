import type { Session, SessionServices } from "../sessions/session";
import { registerCompareHandlers } from "./compare";
import { registerDiffHandlers } from "./diff";
import { registerReviewHandlers } from "./review";
import { registerScanHandlers } from "./scan";
import { registerSessionHandlers } from "./session";
import { registerStartHandlers } from "./start";

/**
 * Installs the session, scan, start-override, comparison, diff and review handlers on a
 * new session.
 */
export function registerSessionCalls(session: Session, services: SessionServices): void {
  registerSessionHandlers(session);
  registerScanHandlers(session, services);
  registerStartHandlers(session, services);
  registerCompareHandlers(session);
  registerDiffHandlers(session, services);
  registerReviewHandlers(session, services);
}
