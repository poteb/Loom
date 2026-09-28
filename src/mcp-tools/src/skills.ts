/*
 * Loom's skills (spec 2026-09-28 §3): the files `skills/<name>/SKILL.md` at the repo root, read from
 * disk at boot and served as they are, so the files in the repo are the only copy. This is the one
 * file in @loom/mcp-tools that touches the filesystem: the server and the channel must read the
 * same files the same way. No text here may contain the em dash character (Paw, 2026-09-23).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderDocument } from "./onboarding.js";

/** One skill: its frontmatter's two values, and the whole file with every CRLF turned into LF. */
export type Skill = { name: string; description: string; text: string };

/** The Agent Skills name rule: lowercase letters and digits, hyphens only between them. */
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;

/** The index's paragraph (spec §4.2). */
const INDEX_INTRO = "Skills for AI agents using this Loom, in the Agent Skills layout. Read the one whose description fits your task. Over an MCP connection to this Loom, `get_skill` with a skill's name returns the same text.";

const byName = (a: Skill, b: Skill): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * Spec §3.2, pure: `raw` as the `SKILL.md` of `folder`. Throws an `Error` naming the folder and the
 * rule broken ("skills/loom-x: name must equal the folder name"). `text` is the normalised file,
 * frontmatter included, so an agent that saves it gets a valid SKILL.md.
 */
export function parseSkill(folder: string, raw: string): Skill {
  const broken = (rule: string): never => { throw new Error(`skills/${folder}: ${rule}`); };
  const text = raw.replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  if (lines[0] !== "---") broken("the first line must be exactly ---");
  const close = lines.indexOf("---", 1);
  if (close === -1) broken("the frontmatter must end at a line that is exactly ---");
  if (close !== 3) broken("the frontmatter must be exactly two lines, name then description");
  const name = /^name: (.*)$/.exec(lines[1]!)?.[1] ?? broken("the first frontmatter line must be name: <value>");
  const description = /^description: (.*)$/.exec(lines[2]!)?.[1] ?? broken("the second frontmatter line must be description: <value>");
  if (name.length > MAX_NAME || !NAME_RE.test(name)) broken("name must be 1 to 64 lowercase letters, digits and single hyphens");
  if (name !== folder) broken("name must equal the folder name");
  if (description.length < 1 || description.length > MAX_DESCRIPTION) broken("description must be 1 to 1024 characters");
  if (!/^[A-Za-z]/.test(description) || /\s$/.test(description)) broken("description must start with a letter and end without a space");
  // Either would stop the value being a plain YAML scalar that every reader parses the same way.
  if (description.includes(": ") || description.includes(" #")) broken("description must contain neither ': ' nor ' #'");
  if (lines[4] !== "" || !lines[5]) broken("one empty line must follow the closing ---, then the body");
  if (!text.endsWith("\n") || text.endsWith("\n\n")) broken("the file must end with exactly one newline");
  return { name, description, text };
}

/**
 * Spec §3.4: every directory in `dir` is a skill and must hold `SKILL.md` and nothing else; plain
 * files directly in `dir` are ignored. Synchronous: it runs once, at boot. Sorted by name.
 */
export function loadSkills(dir: string = defaultSkillsDir()): readonly Skill[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`skills folder not found: ${dir}`);
  const skills = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => {
    const files = readdirSync(path.join(dir, e.name));
    if (!files.includes("SKILL.md")) throw new Error(`skills/${e.name}: the folder must hold SKILL.md`);
    if (files.length !== 1) throw new Error(`skills/${e.name}: the folder must hold SKILL.md and nothing else`);
    return parseSkill(e.name, readFileSync(path.join(dir, e.name, "SKILL.md"), "utf8"));
  });
  return skills.sort(byName);
}

/**
 * `skills/` at the repo root, from this module's own location: three levels below the root both
 * from `src/mcp-tools/src/` (vitest) and from `src/mcp-tools/dist/` (built, and `/app/src/mcp-tools/dist/`
 * in the image). Node resolves the pnpm workspace link to the real path, so the server and the
 * channel land on the same folder. No environment variable overrides it.
 */
export function defaultSkillsDir(): string {
  return fileURLToPath(new URL("../../../skills/", import.meta.url));
}

let loaded: readonly Skill[] | undefined;

/** `loadSkills(defaultSkillsDir())`, once per process. */
export function defaultSkills(): readonly Skill[] {
  loaded ??= loadSkills(defaultSkillsDir());
  return loaded;
}

/**
 * The index (spec §4.2): `join-loom` first, because an agent joins before it works, then the skills
 * in name order, one line each, ending with one newline. `join-loom`'s description is read from
 * `renderDocument` through `parseSkill`, so it is never restated and the generated document is held
 * to the files' format. An empty `origin` gives root-relative links.
 */
export function renderSkillsIndex(skills: readonly Skill[], origin: string): string {
  const joinLoom = parseSkill("join-loom", renderDocument(origin));
  return [
    "# Loom skills",
    "",
    INDEX_INTRO,
    "",
    `- [join-loom](${origin}/join-loom.md): ${joinLoom.description}`,
    ...[...skills].sort(byName).map((s) => `- [${s.name}](${origin}/skills/${s.name}.md): ${s.description}`),
    "",
  ].join("\n");
}
