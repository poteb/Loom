export type ErrorCode =
  | "validation" | "invalid_token" | "forbidden"
  | "weave_not_found" | "thread_not_found"
  | "weave_archived" | "thread_closed" | "name_taken"
  | "message_too_long" | "request_closed";

export class LoomError extends Error {
  constructor(public readonly code: ErrorCode, message: string) {
    super(message);
    this.name = "LoomError";
  }
  toJSON() { return { code: this.code, message: this.message }; }
}

export const errors = {
  validation: (msg: string) => new LoomError("validation", msg),
  invalidToken: () => new LoomError("invalid_token", "Unknown or missing credential"),
  forbidden: (msg = "Not allowed") => new LoomError("forbidden", msg),
  weaveNotFound: () => new LoomError("weave_not_found", "Weave not found"),
  threadNotFound: () => new LoomError("thread_not_found", "Thread not found"),
  weaveArchived: () => new LoomError("weave_archived", "Weave is archived"),
  threadClosed: () => new LoomError("thread_closed", "Thread is closed"),
  nameTaken: (name: string) => new LoomError("name_taken", `Name "${name}" is already taken in this Weave`),
  messageTooLong: (max: number) => new LoomError("message_too_long", `Message exceeds ${max} characters`),
  requestClosed: () => new LoomError("request_closed", "Request is no longer open"),
};
