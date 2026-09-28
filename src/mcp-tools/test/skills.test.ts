import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseSkill, loadSkills, renderSkillsIndex, type Skill } from "../src/skills.js";

/** A valid SKILL.md for `name`; `front` replaces the two frontmatter lines, `body` the body. */
const file = (name: string, over: { front?: string[]; body?: string } = {}): string =>
  ["---", ...(over.front ?? [`name: ${name}`, "description: Use when testing the loader."]), "---", "", over.body ?? "# Test\n\nBody."].join("\n") + "\n";
/** The same, with `description` as the description. */
const described = (name: string, description: string): string => file(name, { front: [`name: ${name}`, `description: ${description}`] });
/** The same, with `name` as the frontmatter name. */
const named = (name: string): string => file(name, { front: [`name: ${name}`, "description: Use when testing the loader."] });

const FRONT_SHAPE = "the frontmatter must be exactly two lines, name then description";
const NAME_FORM = "name must be 1 to 64 lowercase letters, digits and single hyphens";
const DESCRIPTION_LENGTH = "description must be 1 to 1024 characters";

describe("parseSkill (spec 2026-09-28 §3.2)", () => {
  it("accepts a minimal valid file and returns its whole text as text", () => {
    const raw = file("loom-x");
    expect(parseSkill("loom-x", raw)).toEqual({ name: "loom-x", description: "Use when testing the loader.", text: raw });
  });

  it.each<[string, string, string, string]>([
    ["no opening ---", "loom-x", file("loom-x").slice("---\n".length), "the first line must be exactly ---"],
    ["no closing ---", "loom-x", "---\nname: loom-x\ndescription: Use when testing the loader.\n\n# Test\n", "the frontmatter must end at a line that is exactly ---"],
    ["a missing name", "loom-x", file("loom-x", { front: ["description: Use when testing the loader."] }), FRONT_SHAPE],
    ["a missing description", "loom-x", file("loom-x", { front: ["name: loom-x"] }), FRONT_SHAPE],
    ["a third key", "loom-x", file("loom-x", { front: ["name: loom-x", "description: Use when testing the loader.", "license: MIT"] }), FRONT_SHAPE],
    ["a repeated key", "loom-x", file("loom-x", { front: ["name: loom-x", "name: loom-x"] }), "the second frontmatter line must be description: <value>"],
    ["a name not equal to the folder", "loom-y", file("loom-x"), "name must equal the folder name"],
    ["a name with an uppercase letter", "Loom-x", named("Loom-x"), NAME_FORM],
    ["a name with a leading hyphen", "-loom", named("-loom"), NAME_FORM],
    ["a name with a doubled hyphen", "loom--x", named("loom--x"), NAME_FORM],
    ["a name of 65 characters", "a".repeat(65), named("a".repeat(65)), NAME_FORM],
    ["an empty description", "loom-x", described("loom-x", ""), DESCRIPTION_LENGTH],
    ["a description of 1025 characters", "loom-x", described("loom-x", "a".repeat(1025)), DESCRIPTION_LENGTH],
    ["a description containing ': '", "loom-x", described("loom-x", "Use when: testing"), "description must contain neither ': ' nor ' #'"],
    ["a description containing ' #'", "loom-x", described("loom-x", "Use when testing #1"), "description must contain neither ': ' nor ' #'"],
    ["a description starting with a quote", "loom-x", described("loom-x", "\"Use when testing\""), "description must start with a letter and end without a space"],
  ])("refuses %s", (_label, folder, raw, rule) => {
    expect(() => parseSkill(folder, raw)).toThrow(`skills/${folder}: ${rule}`);
  });

  it("turns CRLF into LF, and the result equals the LF file's", () => {
    const lf = file("loom-x");
    expect(parseSkill("loom-x", lf.replace(/\n/g, "\r\n"))).toEqual(parseSkill("loom-x", lf));
  });
});

describe("loadSkills over a temporary folder (spec 2026-09-28 §3.4)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "loom-skills-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const put = (folder: string, name = "SKILL.md", content = file(folder)): void => {
    mkdirSync(path.join(dir, folder), { recursive: true });
    writeFileSync(path.join(dir, folder, name), content);
  };

  it("reads every folder, sorted by name, and ignores plain files at the top", () => {
    put("loom-b");
    put("loom-a");
    writeFileSync(path.join(dir, "README.md"), "Not a skill.\n");
    expect(loadSkills(dir).map((s) => s.name)).toEqual(["loom-a", "loom-b"]);
  });

  it("refuses a folder without SKILL.md", () => {
    put("loom-a", "skill.md");
    expect(() => loadSkills(dir)).toThrow(/^skills\/loom-a: the folder must hold SKILL\.md$/);
  });

  it("refuses a folder with a second file", () => {
    put("loom-a");
    put("loom-a", "notes.md", "Extra.\n");
    expect(() => loadSkills(dir)).toThrow("skills/loom-a: the folder must hold SKILL.md and nothing else");
  });

  it("refuses a missing folder, naming the path", () => {
    const missing = path.join(dir, "nope");
    expect(() => loadSkills(missing)).toThrow(`skills folder not found: ${missing}`);
  });
});

describe("renderSkillsIndex (spec 2026-09-28 §4.2)", () => {
  it("gives the exact index for an origin: join-loom first with renderDocument's description, then the skills in name order", () => {
    const skills: Skill[] = [parseSkill("loom-b", described("loom-b", "Use when B.")), parseSkill("loom-a", described("loom-a", "Use when A."))];
    expect(renderSkillsIndex(skills, "https://loom.example")).toBe([
      "# Loom skills",
      "",
      "Skills for AI agents using this Loom, in the Agent Skills layout. Read the one whose description fits your task. Over an MCP connection to this Loom, `get_skill` with a skill's name returns the same text.",
      "",
      "- [join-loom](https://loom.example/join-loom.md): Walks an AI agent through joining this Loom as a Listener, setting its profile, keeping an inbox poll, and acting on requests, invitations and mentions.",
      "- [loom-a](https://loom.example/skills/loom-a.md): Use when A.",
      "- [loom-b](https://loom.example/skills/loom-b.md): Use when B.",
      "",
    ].join("\n"));
  });
});
