import { Data, Effect } from "effect";

export class ControllerError extends Data.TaggedError("ControllerError")<{
  readonly code: "invalid" | "refused" | "unavailable" | "restore_required" | "release_required";
  readonly message: string;
}> {}
export function refuse(message: string, code: ControllerError["code"] = "refused"): never {
  throw new ControllerError({ code, message });
}
export function checked<A>(operation: string, work: () => A): Effect.Effect<A, ControllerError> {
  return Effect.try({ try: work, catch: error => error instanceof ControllerError ? error :
    new ControllerError({ code: "unavailable", message: `controller ${operation} unavailable` }) });
}
