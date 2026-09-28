import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ERROR_CODES, EVENT_TYPES, PROFILE_KEYS, REQUIREMENT_KEYS } from "@loom/core";
import { registerLoomTools, type LoomToolBackend } from "../src/index.js";
import { parseSkill, loadSkills, defaultSkillsDir, renderSkillsIndex, type Skill } from "../src/skills.js";

// The one seam over the file system: readdirSync is the real one, except in the case that hands
// loadSkills a listing out of order. NTFS lists a folder in name order, so without the seam a case
// on Windows cannot tell a sorted result from the file system's own order.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readdirSync: vi.fn(actual.readdirSync) };
});

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
const BODY_RULE = "one empty line must follow the closing ---, then the body";
const FINAL_NEWLINE = "the file must end with exactly one newline";
const YAML_SPECIAL = "description must have no ':' before whitespace or at its end, and no '#' after whitespace";

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
    ["a description containing ': '", "loom-x", described("loom-x", "Use when: testing"), YAML_SPECIAL],
    ["a description containing ':' then a tab", "loom-x", described("loom-x", "Use when:\ttesting"), YAML_SPECIAL],
    ["a description ending in ':'", "loom-x", described("loom-x", "Use when testing, for example:"), YAML_SPECIAL],
    ["a description containing ' #'", "loom-x", described("loom-x", "Use when testing #1"), YAML_SPECIAL],
    ["a description containing a tab then '#'", "loom-x", described("loom-x", "Use when testing\t#1"), YAML_SPECIAL],
    ["a description starting with a quote", "loom-x", described("loom-x", "\"Use when testing\""), "description must start with a letter and end without a space"],
    ["a description ending in a space", "loom-x", described("loom-x", "Use when testing "), "description must start with a letter and end without a space"],
    ["no empty line after the closing ---", "loom-x", ["---", "name: loom-x", "description: Use when testing the loader.", "---", "# Test", ""].join("\n"), BODY_RULE],
    ["an empty body", "loom-x", "---\nname: loom-x\ndescription: Use when testing the loader.\n---\n\n", BODY_RULE],
    ["no final newline", "loom-x", file("loom-x").slice(0, -1), FINAL_NEWLINE],
    ["two final newlines", "loom-x", file("loom-x") + "\n", FINAL_NEWLINE],
  ])("refuses %s", (_label, folder, raw, rule) => {
    expect(() => parseSkill(folder, raw)).toThrow(`skills/${folder}: ${rule}`);
  });

  it.each<[string, string, string]>([
    ["a name of 64 characters", "a".repeat(64), named("a".repeat(64))],
    ["a description of 1024 characters", "loom-x", described("loom-x", "a".repeat(1024))],
    ["a description with ':' and '#' inside words", "loom-x", described("loom-x", "Use when a:b or PR#1 is tested.")],
  ])("accepts %s", (_label, folder, raw) => {
    expect(parseSkill(folder, raw).text).toBe(raw);
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

  it("reads every folder and ignores plain files at the top", () => {
    put("loom-b");
    put("loom-a");
    writeFileSync(path.join(dir, "README.md"), "Not a skill.\n");
    expect(loadSkills(dir).map((s) => s.name)).toEqual(["loom-a", "loom-b"]);
  });

  it("sorts by name whatever order the file system lists the folders in", async () => {
    put("loom-a");
    put("loom-b");
    put("loom-c");
    const real = (await vi.importActual<typeof import("node:fs")>("node:fs")).readdirSync;
    // loadSkills' first listing is the top folder's; this one call gets it reversed.
    vi.mocked(readdirSync).mockImplementationOnce(((p: string, o: object) => [...real(p, o as { withFileTypes: true })].reverse()) as typeof readdirSync);
    expect(loadSkills(dir).map((s) => s.name)).toEqual(["loom-a", "loom-b", "loom-c"]);
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

// --- The drift guard (spec 2026-09-28 §6) -----------------------------------------------------
// Apart from FIELD_NAMES it keeps no list of its own: tools and their arguments come from the
// registration, error codes, event types, requirement keys and profile keys from core, skills from
// the folder.

const SKILL_NAMES = ["loom-ask-for-review", "loom-do-accepted-work", "loom-request-helpers", "loom-work-in-a-thread"];
const HEADINGS = ["## When to use", "## Steps", "## What you will see", "## When something goes wrong"];

const group = (names: string[], where: string): [string, string][] => names.map((n) => [n, where]);
/**
 * The result, payload and argument names a skill may write in prose, each with the place it
 * exists (spec §6 case 4, set 5). Core declares these shapes as TypeScript types only, so this list
 * is maintained by hand, and keeping it true is a review item: a change that renames or removes one
 * of these updates its entry and the skill texts that name it in the same commit, and an entry is
 * added only with its place.
 */
const FIELD_NAMES = new Map<string, string>([
  ...group(["credential"], "the argument of every credentialed tool (cred in src/mcp-tools/src/tools.ts), named in prose"),
  ...group(["since"], "the argument of inbox and read_events, tools.ts, named in prose"),
  ...group(["name"], "the argument of create_thread, create_weave and get_skill, tools.ts; PublicParticipant.name"),
  ...group(["url"], "the argument of create_thread and open_request, tools.ts; a Thread's url and PublicRequest.url"),
  ...group(["weaveId", "threadId"], "LoomEvent, src/core/src/types.ts; the join_weave and join_lobby results; PublicRequest.threadId"),
  ...group(["requestId"], "the request events' and weave.invited payloads, src/core/src/lobby/requests.ts and invitations.ts"),
  ...group(["participantId"], "the request.offered and request.overdue payloads and PublicOffer, src/core/src/lobby/requests.ts; the thread.invited payload, src/core/src/invites.ts and lobby/invitations.ts"),
  ...group(["invitedBy"], "the thread.invited payload, src/core/src/invites.ts and lobby/invitations.ts"),
  ...group(["model", "effort", "note"], "the arguments of offer, tools.ts; the request.offered payload and PublicOffer, requests.ts"),
  ...group(["inviteId"], "the argument of join_weave, tools.ts, named in prose"),
  ...group(["title", "requirements", "wanted", "timeoutMs", "targetWeaveId", "targetThreadId", "targetCredential"],
    "the arguments of open_request, tools.ts, named in its prose; requirements, wanted, targetWeaveId, targetThreadId also on PublicRequest"),
  ...group(["deadlineMs"], "the argument of accept, tools.ts, named in prose"),
  ...group(["status"], "a find_agents result's listener status, src/core/src/lobby/status.ts"),
  ...group(["seq", "type", "actor", "at", "payload"], "LoomEvent, src/core/src/types.ts"),
  ...group(["payload.text"], "the message payload, src/core/src/messages.ts"),
  ...group(["threadName", "threadUrl"], "InboxItem, src/core/src/types.ts"),
  ...group(["next"], "the next field and block, withNext and withInboxNext in src/mcp-tools/src/tools.ts"),
  ...group(["guidelines"], "the create_weave, join_weave, join_lobby and get_weave results (READ_GUIDELINES, tools.ts)"),
  ...group(["id", "eligible", "offers", "acceptances", "expiresAt"], "PublicRequest, src/core/src/lobby/requests.ts"),
  ...group(["dueAt", "completedAt", "removed", "overdue", "lastSeenAt", "listenerStatus"], "PublicAcceptance, src/core/src/lobby/requests.ts"),
  ...group(["participant.lastSeenAt"], "a find_agents result's participant, PublicParticipant in src/core/src/types.ts"),
  ...group(["currentWork", "cadence"], "a find_agents result, src/core/src/lobby/status.ts"),
  ...group(["invitationId", "targetWeaveTitle"], "the weave.invited payload, invitationRowAndEvent in src/core/src/lobby/invitations.ts"),
  ...group(["reason"], "the request.closed payload, closeInTx in src/core/src/lobby/requests.ts"),
  ...group(["completed", "expired", "cancelled"], "the close reasons, CloseReason in src/core/src/lobby/requests.ts"),
]);

/** A registered tool's input properties, and which of them its input schema requires. */
type ToolArgs = { properties: readonly string[]; required: readonly string[] };

/** The registered tools and each one's input properties, as a client lists them (§6 cases 4 and 5). */
async function registeredTools(): Promise<Map<string, ToolArgs>> {
  const server = new McpServer({ name: "guard", version: "0.0.0" });
  // Listing runs no handler, so the backend is never read.
  registerLoomTools(server, {} as LoomToolBackend, { skills: [], origin: "" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "guard", version: "0" });
  await client.connect(b);
  try {
    const { tools } = await client.listTools();
    return new Map(tools.map((t) => {
      const schema = t.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
      return [t.name, { properties: Object.keys(schema.properties ?? {}), required: schema.required ?? [] }];
    }));
  } finally { await client.close(); }
}

type Known = { tools: ReadonlyMap<string, ToolArgs>; skills: ReadonlySet<string> };
const CALL_RE = /^([a-z][a-z0-9_]*)\((.*)\)$/;
const SKILL_RE = /^[a-z0-9]+(-[a-z0-9]+)+$/;
const IDENT_RE = /^[a-z][A-Za-z0-9_]*(\.[a-z][A-Za-z0-9_]*)*$/;
const BARE_RE = /^[a-z][A-Za-z0-9_]*$/;

/**
 * Why a code span is not known, or null when it is (§6 cases 4 and 5): a call form naming a
 * registered tool with only that tool's arguments and every one it requires but `credential`; a
 * skill name that is loaded or `join-loom`; or an identifier that is a tool, an error code, an event
 * type, a requirement key, a profile key or a FIELD_NAMES entry. A bare word is never accepted for
 * being some tool's argument. Any other shape fails.
 */
function unknownSpan(span: string, known: Known): string | null {
  const call = CALL_RE.exec(span);
  if (call) {
    const args = known.tools.get(call[1]!);
    if (!args) return `no tool named ${call[1]}`;
    const given = call[2] === "" ? [] : call[2]!.split(",").map((a) => a.trim());
    const bad = given.filter((a) => !BARE_RE.test(a) || !args.properties.includes(a));
    if (bad.length > 0) return `${call[1]} takes no ${bad.join(", ")}`;
    // The guard registers with no default credential, so `credential` is required here; the skills
    // leave it out by rule (the credential paragraph of loom-work-in-a-thread).
    const missing = args.required.filter((a) => a !== "credential" && !given.includes(a));
    return missing.length === 0 ? null : `${call[1]} needs ${missing.join(", ")}`;
  }
  if (SKILL_RE.test(span)) return known.skills.has(span) ? null : `no skill named ${span}`;
  if (IDENT_RE.test(span)) {
    const sets: { has(v: string): boolean }[] = [
      known.tools, new Set<string>(ERROR_CODES), new Set<string>(EVENT_TYPES), new Set<string>(REQUIREMENT_KEYS), new Set<string>(PROFILE_KEYS), FIELD_NAMES,
    ];
    return sets.some((set) => set.has(span)) ? null : `unknown word ${span}`;
  }
  return `a span of no known shape: ${span}`;
}

/** A skill's body: everything after the frontmatter, which parseSkill has put on lines 0 to 3. */
const bodyOf = (text: string): string => text.split("\n").slice(4).join("\n");
/** Every backtick code span on one line of `body`. */
const spansOf = (body: string): string[] => body.split("\n").flatMap((line) => [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]!));
/** §6 case 6: any URI scheme followed by ://, mailto:, or a uuid, all case-insensitive. */
const INSTANCE_RE = /[a-z][a-z0-9+.-]*:\/\/|mailto:|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const instanceValues = (text: string): string[] => [...text.matchAll(INSTANCE_RE)].map((m) => m[0]);

describe("the drift guard over the real skills/ folder (spec 2026-09-28 §6)", () => {
  const dir = defaultSkillsDir();
  let skills: readonly Skill[];
  let known: Known;
  beforeAll(async () => {
    skills = loadSkills(dir);
    known = { tools: await registeredTools(), skills: new Set([...skills.map((s) => s.name), "join-loom"]) };
  });

  it("case 1: the loaded names are exactly the four", () => {
    expect(skills.map((s) => s.name)).toEqual(SKILL_NAMES);
  });

  it("case 2: each folder holds only SKILL.md, and each file passes parseSkill", () => {
    for (const s of skills) {
      expect(readdirSync(path.join(dir, s.name)), s.name).toEqual(["SKILL.md"]);
      expect(parseSkill(s.name, readFileSync(path.join(dir, s.name, "SKILL.md"), "utf8")), s.name).toEqual(s);
    }
  });

  it("case 3: each body has the four headings, in order", () => {
    for (const s of skills) {
      expect(bodyOf(s.text).split("\n").filter((l) => HEADINGS.includes(l)), s.name).toEqual(HEADINGS);
    }
  });

  it("cases 4 and 5: every code span is known, and a call form names only that tool's arguments", () => {
    const unknown = skills.flatMap((s) => spansOf(bodyOf(s.text))
      .map((span) => unknownSpan(span, known))
      .filter((why): why is string => why !== null)
      .map((why) => `${s.name}: ${why}`));
    expect(unknown).toEqual([]);
  });

  it("every FIELD_NAMES entry is used by at least one skill", () => {
    const used = new Set(skills.flatMap((s) => spansOf(bodyOf(s.text))));
    expect([...FIELD_NAMES.keys()].filter((f) => !used.has(f))).toEqual([]);
  });

  it("case 6: no file contains a URL or a uuid", () => {
    for (const s of skills) expect(instanceValues(s.text), s.name).toEqual([]);
  });

  it("case 7: no file contains the em dash character (U+2014)", () => {
    const emDash = String.fromCharCode(0x2014);
    for (const s of skills) expect(s.text.includes(emDash), s.name).toBe(false);
  });
});

describe("the code-span classifier (spec 2026-09-28 §6 case 4)", () => {
  let known: Known;
  beforeAll(async () => { known = { tools: await registeredTools(), skills: new Set(["loom-ask-for-review", "join-loom"]) }; });

  it.each([
    "complete",                                        // a tool as a bare word
    "thread_closed",                                   // an error code
    "request.opened",                                  // an event type
    "maxResponseMs",                                   // a requirement key
    "pollIntervalMs",                                  // a profile key
    "dueAt",                                           // a FIELD_NAMES entry
    "loom-ask-for-review",                             // a skill name
    "accept(requestId, participantIds, deadlineMs)",   // a call form
    "inbox(weaveId)",                                  // a call form leaving out only optional arguments
  ])("passes %s", (span) => {
    expect(unknownSpan(span, known)).toBeNull();
  });

  it.each([
    "limit",                        // some tool's argument, but not in FIELD_NAMES
    "inbox(weaveId, threadId)",     // an argument that tool does not take
    "accept(requestId)",            // a call form leaving out a required argument
    "post_message()",               // a call form with none of its required arguments
    "finish",                       // an unknown lowercase word
    "finish_work",                  // an unknown snake_case word
    "request.renamed",              // an unknown dotted type
    "loom-do-everything",           // an unknown skill name
    "finish(requestId)",            // a call form naming no tool
    "[]", "{ model }", "@",         // spans of another shape
  ])("fails %s", (span) => {
    expect(unknownSpan(span, known)).not.toBeNull();
  });
});

describe("the instance-value check (spec 2026-09-28 §6 case 6)", () => {
  it.each<[string, string]>([
    ["a lowercase uuid", "id 3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b here"],
    ["an uppercase uuid", "id 3F2B8C1E-9A4D-4E6F-8B2A-1C3D5E7F9A0B here"],
    ["http://", "see http://x"],
    ["HTTPS://", "see HTTPS://X"],
    ["ftp://", "see ftp://x"],
    ["ws://", "see ws://x"],
    ["loom://", "see loom://guidelines"],
    ["git+ssh://", "see git+ssh://x"],
    ["MAILTO:", "write to MAILTO:someone"],
  ])("catches %s", (_label, text) => {
    expect(instanceValues(text)).not.toEqual([]);
  });

  it.each(["@Reviewer", "PR 23", "at <sha>, <link>", "the rule: reply"])("passes %s", (text) => {
    expect(instanceValues(text)).toEqual([]);
  });
});
