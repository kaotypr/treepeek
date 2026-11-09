import * as v from "valibot";
import {
  type CallDef,
  type CallMap,
  type CallResponse,
  err,
  InvokeEnvelopeSchema,
  mainCalls,
  parseRequest,
  type Result,
} from "../shared/ipc";
import type { Logger } from "../shared/log";

export interface MainCallContext {
  windowId: number;
}

export type MainHandler<C extends CallDef> = (
  ctx: MainCallContext,
  request: v.InferOutput<C["request"]>,
) => Result<CallResponse<C>> | Promise<Result<CallResponse<C>>>;

/**
 * Routes `{ch, p}` envelopes from a window to main's handlers. Electron-free, so it can be
 * unit-tested: unknown channels and invalid payloads return `invalidRequest`, and a
 * throwing handler returns `internal`.
 */
export class MainRouter {
  readonly #calls: CallMap;
  readonly #log: Logger;
  readonly #handlers = new Map<string, { call: CallDef; handler: MainHandler<CallDef> }>();

  constructor(log: Logger, calls: CallMap = mainCalls) {
    this.#log = log;
    this.#calls = calls;
  }

  handle<C extends CallDef>(call: C, handler: MainHandler<C>): void {
    if (!Object.hasOwn(this.#calls, call.name)) {
      throw new Error(`${call.name} is not a main channel in the contract`);
    }
    this.#handlers.set(call.name, { call, handler: handler as unknown as MainHandler<CallDef> });
  }

  async dispatch(envelope: unknown, ctx: MainCallContext): Promise<Result<unknown>> {
    const parsed = v.safeParse(InvokeEnvelopeSchema, envelope);
    if (!parsed.success) {
      this.#log.warn("rejected a malformed invoke envelope", { windowId: ctx.windowId });
      return err("invalidRequest", "Malformed request");
    }
    const { ch, p } = parsed.output;
    const entry = Object.hasOwn(this.#calls, ch) ? this.#handlers.get(ch) : undefined;
    if (!entry) {
      this.#log.warn("rejected a call on an unknown channel", {
        channel: ch,
        windowId: ctx.windowId,
      });
      return err("invalidRequest", `Unknown channel: ${ch}`);
    }
    const request = parseRequest(entry.call, p);
    if (!request.ok) {
      this.#log.warn("rejected an invalid request", { channel: ch, issues: request.error.detail });
      return request;
    }
    try {
      return await entry.handler(ctx, request.value);
    } catch (error) {
      this.#log.error("handler failed", { channel: ch, error });
      return err("internal", `${ch} failed`);
    }
  }
}
