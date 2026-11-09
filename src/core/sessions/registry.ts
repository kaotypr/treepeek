import type { Logger } from "../../shared/log";
import { CoreRpc, type PortLike } from "../rpc";
import { Session, type SessionServices } from "./session";

/** The sessions of the core service, one per window. */
export class SessionRegistry {
  readonly #sessions = new Map<number, Session>();
  readonly #log: Logger;
  readonly #services: SessionServices;
  readonly #register: (session: Session) => void;

  /** `register` installs the call handlers on each new session's RPC endpoint. */
  constructor(log: Logger, services: SessionServices, register: (session: Session) => void) {
    this.#log = log;
    this.#services = services;
    this.#register = register;
  }

  /** Opens a session for a window, replacing (and closing) one it already had. */
  open(windowId: number, port: PortLike): Session {
    this.close(windowId);
    const log = this.#log.child(`window-${windowId}`);
    const rpc = new CoreRpc(port, { windowId, log });
    const session = new Session(windowId, rpc, this.#services, log);
    this.#register(session);
    this.#sessions.set(windowId, session);
    rpc.hello();
    this.#log.info("session opened", { windowId });
    return session;
  }

  /** Closes a window's session: its scan stops and what it held is released. */
  close(windowId: number): void {
    const session = this.#sessions.get(windowId);
    if (!session) return;
    this.#sessions.delete(windowId);
    session.close();
    this.#log.info("session closed", { windowId });
  }

  get(windowId: number): Session | undefined {
    return this.#sessions.get(windowId);
  }

  all(): Session[] {
    return [...this.#sessions.values()];
  }

  /** Closes every session (the core service shutting down). */
  closeAll(): void {
    for (const windowId of [...this.#sessions.keys()]) this.close(windowId);
  }

  get size(): number {
    return this.#sessions.size;
  }
}
