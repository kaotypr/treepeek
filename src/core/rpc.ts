import * as v from "valibot";
import {
  type CallDef,
  type CallMap,
  type CallResponse,
  CONTRACT_VERSION,
  coreCalls,
  type EventDef,
  type EventPayload,
  err,
  ok,
  PortCallSchema,
  type PortFromCore,
  parseEvent,
  parseRequest,
  type Result,
} from "../shared/ipc";
import type { Logger } from "../shared/log";

/** The part of a MessagePort the RPC layer needs; adapters wrap Electron's and Node's. */
export interface PortLike {
  postMessage(message: PortFromCore): void;
  onMessage(listener: (data: unknown) => void): void;
  close(): void;
}

export interface CallContext {
  windowId: number;
  log: Logger;
}

export type CoreHandler<C extends CallDef> = (
  ctx: CallContext,
  request: v.InferOutput<C["request"]>,
  signal: AbortSignal,
) => Result<CallResponse<C>> | Promise<Result<CallResponse<C>>>;

interface Registered {
  call: CallDef;
  handler: CoreHandler<CallDef>;
}

interface Pending {
  controller: AbortController;
  cancel: () => void;
}

/**
 * One window's RPC endpoint inside the core service. Every incoming call is checked
 * against the contract: unknown channels and payloads that fail their schema return
 * `invalidRequest`, and nothing a handler throws crosses the port.
 *
 * A call whose payload carries a `requestId` can be cancelled with `request.cancel`: its
 * handler's signal is aborted and the call resolves `cancelled` at once.
 */
export class CoreRpc {
  readonly #port: PortLike;
  readonly #ctx: CallContext;
  readonly #calls: CallMap;
  readonly #handlers = new Map<string, Registered>();
  readonly #pending = new Map<string, Pending>();
  readonly #inflight = new Set<AbortController>();
  #closed = false;

  constructor(port: PortLike, ctx: CallContext, calls: CallMap = coreCalls) {
    this.#port = port;
    this.#ctx = ctx;
    this.#calls = calls;
    this.onCall(coreCalls["request.cancel"], (_ctx, request) => {
      this.#pending.get(request.requestId)?.cancel();
      return ok({});
    });
    port.onMessage((data) => {
      void this.#receive(data);
    });
  }

  onCall<C extends CallDef>(call: C, handler: CoreHandler<C>): void {
    this.#handlers.set(call.name, { call, handler: handler as unknown as CoreHandler<CallDef> });
  }

  emit<E extends EventDef>(event: E, payload: EventPayload<E>): void {
    if (this.#closed) return;
    const parsed = parseEvent(event, payload);
    if (!parsed.ok) {
      this.#ctx.log.error("refusing to emit an invalid event payload", parsed.error);
      return;
    }
    this.#port.postMessage({ t: "event", ch: event.name, p: parsed.value });
  }

  hello(): void {
    this.#port.postMessage({ t: "hello", contractVersion: CONTRACT_VERSION });
  }

  /** Runs one call through validation, cancellation and error capture. */
  async dispatch(channel: string, payload: unknown): Promise<Result<unknown>> {
    const entry = Object.hasOwn(this.#calls, channel) ? this.#handlers.get(channel) : undefined;
    if (!entry) {
      this.#ctx.log.warn("rejected a call on an unknown channel", { channel });
      return err("invalidRequest", `Unknown channel: ${channel}`);
    }
    const parsed = parseRequest(entry.call, payload);
    if (!parsed.ok) {
      this.#ctx.log.warn("rejected an invalid request", { channel, issues: parsed.error.detail });
      return parsed;
    }

    // `request.cancel` names the call it cancels; it is not itself cancellable.
    const requestId =
      channel === coreCalls["request.cancel"].name ? undefined : readRequestId(parsed.value);
    if (requestId !== undefined && this.#pending.has(requestId)) {
      return err("invalidRequest", `Request id already in use: ${requestId}`);
    }

    const controller = new AbortController();
    this.#inflight.add(controller);
    let resolveCancelled!: (result: Result<unknown>) => void;
    const cancelled = new Promise<Result<unknown>>((resolve) => {
      resolveCancelled = resolve;
    });
    const cancel = () => {
      if (controller.signal.aborted) return;
      controller.abort();
      resolveCancelled(err("cancelled", `${channel} was cancelled`));
    };
    if (requestId !== undefined) this.#pending.set(requestId, { controller, cancel });

    const run = (async (): Promise<Result<unknown>> => {
      try {
        return await entry.handler(this.#ctx, parsed.value, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) return err("cancelled", `${channel} was cancelled`);
        this.#ctx.log.error("handler failed", { channel, error });
        return err("internal", `${channel} failed`);
      }
    })();

    try {
      return await Promise.race([run, cancelled]);
    } finally {
      this.#inflight.delete(controller);
      if (requestId !== undefined) this.#pending.delete(requestId);
    }
  }

  /** Aborts everything in flight and closes the port (window closed or re-attached). */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const controller of this.#inflight) controller.abort();
    for (const pending of this.#pending.values()) pending.cancel();
    this.#port.close();
  }

  async #receive(data: unknown): Promise<void> {
    const message = v.safeParse(PortCallSchema, data);
    if (!message.success) {
      this.#ctx.log.warn("dropped a malformed port message", { issues: v.flatten(message.issues) });
      return;
    }
    const { id, ch, p } = message.output;
    const result = await this.dispatch(ch, p);
    if (!this.#closed) this.#port.postMessage({ t: "result", id, r: result });
  }
}

function readRequestId(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || !("requestId" in value)) return undefined;
  const id = (value as { requestId: unknown }).requestId;
  return typeof id === "string" ? id : undefined;
}
