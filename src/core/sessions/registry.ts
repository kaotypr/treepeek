import type { Logger } from "../../shared/log";
import { CoreRpc, type PortLike } from "../rpc";

/**
 * A window's session in the core service. Later plans add its scan root, scan result and
 * subscriptions; repository-level work stays shared across sessions.
 */
export interface Session {
  readonly id: number;
  readonly rpc: CoreRpc;
}

export class SessionRegistry {
  readonly #sessions = new Map<number, Session>();
  readonly #log: Logger;
  readonly #register: (rpc: CoreRpc) => void;

  /** `register` installs the call handlers on each new session's RPC endpoint. */
  constructor(log: Logger, register: (rpc: CoreRpc) => void) {
    this.#log = log;
    this.#register = register;
  }

  /** Opens a session for a window, replacing (and closing) one it already had. */
  open(windowId: number, port: PortLike): Session {
    this.close(windowId);
    const rpc = new CoreRpc(port, { windowId, log: this.#log.child(`window-${windowId}`) });
    this.#register(rpc);
    const session: Session = { id: windowId, rpc };
    this.#sessions.set(windowId, session);
    rpc.hello();
    this.#log.info("session opened", { windowId });
    return session;
  }

  close(windowId: number): void {
    const session = this.#sessions.get(windowId);
    if (!session) return;
    this.#sessions.delete(windowId);
    session.rpc.close();
    this.#log.info("session closed", { windowId });
  }

  get(windowId: number): Session | undefined {
    return this.#sessions.get(windowId);
  }

  get size(): number {
    return this.#sessions.size;
  }
}
