import * as v from "valibot";
import { err, type Result } from "./result";

/** A request/response channel. `request` validates what the caller sends. */
export interface CallDef<
  N extends string = string,
  Req extends v.GenericSchema = v.GenericSchema,
  Res extends v.GenericSchema = v.GenericSchema,
> {
  readonly kind: "call";
  readonly name: N;
  readonly request: Req;
  readonly response: Res;
}

/**
 * A pushed channel. A `sticky` event keeps its latest payload in the preload, so a
 * subscriber that registers late still receives the current value (state-like events).
 */
export interface EventDef<N extends string = string, P extends v.GenericSchema = v.GenericSchema> {
  readonly kind: "event";
  readonly name: N;
  readonly payload: P;
  readonly sticky: boolean;
}

export function defineCall<
  const N extends string,
  Req extends v.GenericSchema,
  Res extends v.GenericSchema,
>(def: { name: N; request: Req; response: Res }): CallDef<N, Req, Res> {
  return Object.freeze({ kind: "call", ...def });
}

export function defineEvent<const N extends string, P extends v.GenericSchema>(def: {
  name: N;
  payload: P;
  sticky?: boolean;
}): EventDef<N, P> {
  return Object.freeze({
    kind: "event",
    name: def.name,
    payload: def.payload,
    sticky: !!def.sticky,
  });
}

export type CallRequest<C> =
  C extends CallDef<string, infer Req, v.GenericSchema> ? v.InferInput<Req> : never;
export type CallResponse<C> =
  C extends CallDef<string, v.GenericSchema, infer Res> ? v.InferOutput<Res> : never;
export type EventPayload<E> = E extends EventDef<string, infer P> ? v.InferOutput<P> : never;

export type CallMap = Readonly<Record<string, CallDef>>;
export type EventMap = Readonly<Record<string, EventDef>>;

/** Turns a dotted channel map (`"settings.get"`) into the nested API (`settings.get()`). */
type Head<S extends string> = S extends `${infer H}.${string}` ? H : S;
type Tail<S extends string, H extends string> = S extends `${H}.${infer T}` ? T : never;

/** A call whose request has no required field may be made without an argument. */
export type CallFn<C> =
  Record<never, never> extends CallRequest<C>
    ? (request?: CallRequest<C>) => Promise<Result<CallResponse<C>>>
    : (request: CallRequest<C>) => Promise<Result<CallResponse<C>>>;

export type NestedApi<M extends CallMap> = {
  readonly [H in Head<keyof M & string>]: {
    readonly [K in keyof M & string as K extends `${H}.${string}` ? Tail<K, H> : never]: CallFn<
      M[K]
    >;
  };
};

/**
 * Parses a payload against a call's request schema. A failure is an `invalidRequest`
 * result carrying Valibot's flattened issues, never a thrown error.
 */
export function parseRequest<C extends CallDef>(
  call: C,
  payload: unknown,
): Result<v.InferOutput<C["request"]>> {
  const parsed = v.safeParse(call.request, payload);
  if (parsed.success) return { ok: true, value: parsed.output };
  return err("invalidRequest", `Invalid request for ${call.name}`, v.flatten(parsed.issues));
}

/** Parses an event payload; used by emitters so a bad payload never leaves its process. */
export function parseEvent<E extends EventDef>(
  event: E,
  payload: unknown,
): Result<v.InferOutput<E["payload"]>> {
  const parsed = v.safeParse(event.payload, payload);
  if (parsed.success) return { ok: true, value: parsed.output };
  return err("internal", `Invalid payload for event ${event.name}`, v.flatten(parsed.issues));
}
