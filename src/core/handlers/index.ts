import type { Session, SessionServices } from "../sessions/session";
import { registerScanHandlers } from "./scan";
import { registerSessionHandlers } from "./session";
import { registerStartHandlers } from "./start";

/** Installs the session, scan and start-override handlers on a new session. */
export function registerSessionCalls(session: Session, services: SessionServices): void {
  registerSessionHandlers(session);
  registerScanHandlers(session);
  registerStartHandlers(session, services);
}
