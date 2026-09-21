import type { ListenersQuery, ListenersSort, ServesKind } from "@loom/client";

/**
 * The part of the directory that lives in the query string (spec §5.4): the search, the four
 * filters and the sort. `limit` and `cursor` are deliberately not here — a link should reproduce a
 * *view*, not a scroll position, and someone else's cursor means nothing on your Lobby.
 */
export type ListenersView = {
  q: string; models: { model: string; effort?: string }[]; tools: string[];
  runtime?: string; serves?: ServesKind; sort: ListenersSort; dir: "asc" | "desc";
};

/**
 * Core's own rule, quoted (`listeners-input.ts`): a **NUL** in `q`, in a tool, in a runtime or in a
 * model's `model`/`effort` is `errors.validation` there, because `\u0000` is the one character a
 * Postgres text parameter and a jsonb value cannot carry. So a link holding one is read here rather
 * than forwarded: forwarding it turns a hand-edited URL into core's 400 and an error page, which is
 * the one thing §5.4 says must not happen.
 *
 * Nothing else is dropped. A tab or a newline inside a value is stored by `validateProfile`,
 * matched by Postgres and handed back out by the directory in a facet value and in a cursor — so a
 * link carrying one is very often a link **this page wrote**, and dropping it would both lose the
 * filter and accuse a good link of not being understood (PR #20 review round 1).
 */
const NUL_RE = /\u0000/;

/**
 * What a `filter` and a model alternative may contain. Core rejects unknown keys — a top-level one
 * in `validateListenersQuery`, one inside a model alternative in `validateRequirements`' strict
 * schema — so anything else is `validation` there rather than something quietly ignored; and the
 * rule that nothing is dropped silently is about a **key** as much as about a value: a link
 * carrying `{"owner":"ada"}` is asking for something this page cannot do, and saying nothing would
 * let it look as though it had been honoured.
 */
const FILTER_KEYS = ["models", "tools", "runtime", "serves"];
const MODEL_KEYS = ["model", "effort"];

/** The untouched page: the defaults core would have applied anyway. Never mutated in place. */
export const EMPTY_VIEW: ListenersView = { q: "", models: [], tools: [], sort: "name", dir: "asc" };

/**
 * Parses `location.search`. Never throws: a hand-edited or truncated link still shows the directory
 * (spec §5.4), and the one thing it may not do is drop a value **silently**.
 *
 * `partial` is what renders the "part of this link was not understood" line, and it is set by every
 * value that was **supplied and is not usable** — including one entry of an array. A `.filter()`
 * that quietly removes three of four models is a link that lies about what it is showing. A value
 * that is merely absent is not a drop and is not reported.
 *
 * The bounds are core's own (`matching.ts:26-33`, spec §2.3): model 1–100, effort 1–32, at most 20
 * alternatives; tools 1–64 each, at most 50; runtime 1–64; `q` ≤ 100; and the three closed enums.
 * Validating them *here* is what keeps a hand-edited link from becoming core's 400 and an error
 * page — the page the spec says must still render.
 */
export function viewFromSearch(search: string): { view: ListenersView; partial: boolean } {
  const p = new URLSearchParams(search);
  let partial = false;
  const drop = () => { partial = true; return undefined; };
  // Supplied-and-unusable is dropped **and** reported; absent is neither. Every helper below goes
  // through this, so no branch can forget half of the rule.
  const given = <T>(raw: unknown, parse: (v: unknown) => T | undefined): T | undefined =>
    raw === undefined ? undefined : parse(raw);
  const str = (v: unknown, max: number): string | undefined => {
    if (typeof v !== "string") return drop();
    // Core trims, so the page compares what core will store — and `validateProfile` trims every
    // field it writes (`owner`, `tools`, `runtime`, `models[].model`/`effort`, `serves`), so no
    // stored value ever has whitespace at an end for this trim to eat.
    const t = v.trim();
    if (t.length < 1 || t.length > max) return drop();
    return NUL_RE.test(t) ? drop() : t;
  };
  const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined =>
    typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : drop();

  const raw = p.get("filter");
  let filter: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      // A JSON array, `null` and a scalar all parse; none of them is a filter.
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) filter = parsed as Record<string, unknown>;
      else drop();
    } catch { drop(); }
  }
  for (const k of Object.keys(filter)) if (!FILTER_KEYS.includes(k)) drop();
  const models = given(filter.models, (v) => {
    if (!Array.isArray(v)) return drop();
    const out: { model: string; effort?: string }[] = [];
    for (const m of v) {
      // An entry that is thrown away is thrown away **out loud**.
      if (!m || typeof m !== "object" || Array.isArray(m)) { drop(); continue; }
      // A key core's strict schema would refuse takes the alternative with it, for the reason an
      // unusable `effort` does: honouring the half it understood answers a wider question than the
      // link asked, and does it silently.
      if (Object.keys(m).some((k) => !MODEL_KEYS.includes(k))) { drop(); continue; }
      const { model, effort } = m as { model?: unknown; effort?: unknown };
      const name = str(model, 100);
      if (name === undefined) continue;                       // `str` has already dropped it
      if (effort === undefined) { out.push({ model: name }); continue; }
      const e = str(effort, 32);
      // An alternative whose effort is unusable is dropped whole rather than widened to "any
      // effort": keeping half of it would silently answer a different question.
      if (e !== undefined) out.push({ model: name, effort: e });
    }
    if (out.length > 20) { drop(); return out.slice(0, 20); }  // core's `.max(20)`
    return out;
  }) ?? [];
  const tools = given(filter.tools, (v) => {
    if (!Array.isArray(v)) return drop();
    const out: string[] = [];
    for (const t of v) { const s = str(t, 64); if (s !== undefined) out.push(s); }
    if (out.length > 50) { drop(); return out.slice(0, 50); }
    return out;
  }) ?? [];
  const runtime = given(filter.runtime, (v) => str(v, 64));
  const serves = given(filter.serves, (v) => oneOf(v, ["anyone", "owner", "list"] as const));
  // The scalars are `string | null` out of `URLSearchParams`; `null` is "not there".
  const sort = given(p.get("sort") ?? undefined, (v) => oneOf(v, ["name", "owner", "joined"] as const)) ?? "name";
  const dir = given(p.get("dir") ?? undefined, (v) => oneOf(v, ["asc", "desc"] as const)) ?? "asc";
  // `?q=` (empty) is a cleared box, not a rejected value: absent, and not reported.
  const qRaw = p.get("q");
  const q = qRaw === null || qRaw.trim() === "" ? "" : (str(qRaw, 100) ?? "");
  return { view: { q, models, tools, runtime, serves, sort, dir }, partial };
}

/**
 * The inverse. `filter` is written only when at least one of the four is set, and the two scalars
 * only when they differ from core's defaults, so an untouched page leaves no query string at all
 * and a link to it is just `/lobby/listeners`.
 */
export function searchFromView(view: ListenersView): string {
  const p = new URLSearchParams();
  if (view.q !== "") p.set("q", view.q);
  const filter: Record<string, unknown> = {};
  if (view.models.length > 0) filter.models = view.models;
  if (view.tools.length > 0) filter.tools = view.tools;
  if (view.runtime !== undefined) filter.runtime = view.runtime;
  if (view.serves !== undefined) filter.serves = view.serves;
  if (Object.keys(filter).length > 0) p.set("filter", JSON.stringify(filter));
  if (view.sort !== "name") p.set("sort", view.sort);
  if (view.dir !== "asc") p.set("dir", view.dir);
  return p.toString();
}

/**
 * The **one** place this feature touches the history API (spec §5.4), kept beside the codec that
 * writes the string rather than inside the component that happens to call it.
 *
 * `replaceState`, never `pushState`: ten keystrokes' worth of filtering must not become ten
 * back-button steps, and the back button leaving the directory is what a human means by it here.
 *
 * Two conditions, each for its own reason:
 * - **the path is exactly this page's**, either spelling the server serves. Rewriting the query
 *   string of the page you are already on names the same page, which is the whole argument for
 *   being allowed to do it; a `startsWith` would rewrite some other page that begins the same way.
 *   This is also the whole of the rule now, and the permission to *leave* is deliberately not
 *   consulted (spec §4.5): a `replaceState` onto the path the browser is **already on** adds no
 *   entry, loads nothing, and takes away no address this browser could otherwise have survived —
 *   so there is nothing for `leavingIsSafe` to protect, because nothing is being left.
 * - **the string would actually change.** A no-op `replaceState` is still a history write.
 */
export function writeSearch(view: ListenersView): void {
  const path = location.pathname;
  if (path !== "/lobby/listeners" && path !== "/lobby/listeners/") return;
  const search = searchFromView(view);
  const next = search ? `${path}?${search}` : path;
  if (next === `${path}${location.search}`) return;
  history.replaceState(null, "", next);
}

/**
 * What the view asks core for. Absent is `undefined` and nothing else — an empty chip row and a
 * cleared search box are **no filter**, not a filter matching nothing, so neither is sent (the
 * client would otherwise put `"tools":[]` on the wire, which core reads as no filter anyway but
 * which makes every request carry a filter it does not have).
 */
export function queryFromView(
  view: ListenersView,
  /** `facets: false` is Show more's: the facets describe the filters, which appending cannot
   *  change, and the facet pass is the most expensive read this query makes (spec §6). */
  extra: { limit?: number; cursor?: string; facets?: boolean } = {},
): ListenersQuery {
  const query: ListenersQuery = { sort: view.sort, dir: view.dir, limit: extra.limit ?? 50 };
  if (view.q !== "") query.q = view.q;
  if (view.models.length > 0) query.models = view.models;
  if (view.tools.length > 0) query.tools = view.tools;
  if (view.runtime !== undefined) query.runtime = view.runtime;
  if (view.serves !== undefined) query.serves = view.serves;
  if (extra.cursor !== undefined) query.cursor = extra.cursor;
  if (extra.facets === false) query.facets = false;
  return query;
}
