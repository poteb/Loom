import { errors } from "./errors.js";

export const NAME_RE = /^[A-Za-z0-9_.-]{1,32}$/;

export function validateName(name: string): string {
  const trimmed = name.trim();
  if (!NAME_RE.test(trimmed)) {
    throw errors.validation("Name must be 1-32 characters of A-Z, a-z, 0-9, _ . -");
  }
  return trimmed;
}
