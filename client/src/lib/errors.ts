/**
 * The sentence to put in front of the user for a failure.
 *
 * Local errors carry a machine-readable code, never a sentence — every word
 * of Persian in the product lives in copy.json. An unrecognised failure falls
 * back to the generic apology rather than being shown raw.
 */

import { copy } from "@/lib/copy";

/** A local failure, named the way the server's used to be. */
export class LocalError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "LocalError";
  }
}

export function messageFor(error: unknown): string {
  const code = error instanceof LocalError ? error.code : "server_error";
  switch (code) {
    case "category_name_length":
      return copy.errors.categoryNameLength;
    case "category_busy":
      return copy.errors.categoryBusy;
    case "too_many_categories":
      return copy.errors.tooManyCategories;
    case "category_not_found":
      return copy.errors.categoryNotFound;
    case "bad_duration":
    case "bad_interval":
      return copy.errors.badDuration;
    case "not_cancellable":
      return copy.errors.notCancellable;
    case "nothing_ringing":
      return copy.errors.nothingRinging;
    case "session_not_found":
      return copy.errors.sessionNotFound;
    default:
      return copy.login.serverError;
  }
}
