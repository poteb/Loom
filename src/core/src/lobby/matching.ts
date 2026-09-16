import { z } from "zod";
import { errors } from "../errors.js";

/** One model a listener offers, at the effort it offers it at. */
export type ModelSpec = { model: string; effort: string };

/** A listener's self-declared Lobby capabilities. Open-ended: unknown keys are carried, never matched on. */
export type Profile = {
  models?: ModelSpec[];
  tools?: string[];
  runtime?: string;
  spawnsSubagents?: boolean;
  owner?: string;
  serves?: "owner" | "anyone" | string[];
  [k: string]: unknown;
};

/** What a request asks of a listener. `models` are alternatives; `tools` are all required. */
export type Requirements = {
  models?: { model: string; effort?: string }[];
  tools?: string[];
  runtime?: string;
  spawnsSubagents?: boolean;
};

const reqSchema = z.object({
  models: z.array(z.object({
    model: z.string().trim().min(1).max(100),
    effort: z.string().trim().min(1).max(32).optional(),
  }).strict()).min(1).max(20).optional(),
  tools: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
  runtime: z.string().trim().min(1).max(64).optional(),
  spawnsSubagents: z.boolean().optional(),
}).strict();

/** The one rule for a request's requirements: known keys only, within their bounds, trimmed. */
export function validateRequirements(r: unknown): Requirements {
  const p = reqSchema.safeParse(r);
  if (!p.success) throw errors.validation(p.error.issues.map((i) => `requirements.${i.path.join(".")}: ${i.message}`).join("; "));
  return p.data;
}

/** True when every requirement present is satisfied: any one model alternative, every tool, equal runtime and spawnsSubagents. */
export function matches(profile: Profile, req: Requirements): boolean {
  if (req.models && !req.models.some((want) => (profile.models ?? []).some((have) => have.model === want.model && (want.effort === undefined || have.effort === want.effort)))) return false;
  if (req.tools && !req.tools.every((t) => (profile.tools ?? []).includes(t))) return false;
  if (req.runtime !== undefined && profile.runtime !== req.runtime) return false;
  if (req.spawnsSubagents !== undefined && profile.spawnsSubagents !== req.spawnsSubagents) return false;
  return true;
}

/** The serving policy: whose requests this profile will take. The empty owner is admitted only by "anyone". */
export function admits(profile: Profile, owner: string): boolean {
  const serves = profile.serves ?? "owner";
  if (serves === "anyone") return true;
  if (serves === "owner") return owner !== "" && profile.owner === owner;
  return owner !== "" && serves.includes(owner);
}

/** Matches ∧ admits. A participant with no profile is never eligible. */
export function eligible(profile: Profile | null, req: Requirements, owner: string): boolean {
  return profile !== null && matches(profile, req) && admits(profile, owner);
}
