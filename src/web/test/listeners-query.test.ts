// @vitest-environment happy-dom
// The codec itself is pure, but the one `replaceState` rule lives beside it (the plan's
// file-structure table) and it is a rule about `location` and `history`, so the file needs a window.
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  EMPTY_VIEW, queryFromView, searchFromView, viewFromSearch, writeSearch, type ListenersView,
} from "../src/components/listeners/listeners-query.js";
import { pathForView, viewOfPath } from "../src/lobby-view.js";

/** A view with every control set, used for the round trip and as the base of the bound cases. */
const FULL: ListenersView = {
  q: "fable",
  models: [{ model: "opus-5", effort: "high" }, { model: "sonnet-5" }],
  tools: ["shell", "github"],
  runtime: "node",
  serves: "anyone",
  sort: "owner",
  dir: "desc",
};

/** `?filter=<json>`, written the way the page writes it. */
const filterSearch = (filter: unknown) => `?filter=${encodeURIComponent(JSON.stringify(filter))}`;
const repeat = (n: number) => "x".repeat(n);

describe("the listeners query string (spec §5.4)", () => {
  it("reads an empty query string as the untouched page", () => {
    expect(viewFromSearch("")).toEqual({ view: EMPTY_VIEW, partial: false });
  });

  it("writes nothing for the untouched page: a link to it carries no query string", () => {
    expect(searchFromView(EMPTY_VIEW)).toBe("");
  });

  it("round-trips every control", () => {
    expect(viewFromSearch(`?${searchFromView(FULL)}`).view).toEqual(FULL);
  });

  it("reports nothing about a link it understood whole", () => {
    expect(viewFromSearch(`?${searchFromView(FULL)}`).partial).toBe(false);
  });

  it("reports nothing about a link that uses every bound core allows", () => {
    const bounds: ListenersView = {
      q: repeat(100),
      models: Array.from({ length: 20 }, (_, i) => ({ model: `${repeat(98)}-${i % 10}`, effort: repeat(32) })),
      tools: Array.from({ length: 50 }, (_, i) => `${repeat(62)}-${i % 10}`),
      runtime: repeat(64),
      serves: "list",
      sort: "joined",
      dir: "desc",
    };
    expect(viewFromSearch(`?${searchFromView(bounds)}`)).toEqual({ view: bounds, partial: false });
  });
});

describe("a link the listeners page cannot read whole (spec §5.4)", () => {
  it("does not throw on a filter that is not JSON, and says the link was not understood", () => {
    expect(viewFromSearch("?filter=not-json")).toEqual({ view: EMPTY_VIEW, partial: true });
  });

  it("drops a filter that is a JSON array: it parses, and it is not a filter", () => {
    expect(viewFromSearch(filterSearch([]))).toEqual({ view: EMPTY_VIEW, partial: true });
  });

  it("drops a filter that is JSON null, for the same reason", () => {
    expect(viewFromSearch(filterSearch(null))).toEqual({ view: EMPTY_VIEW, partial: true });
  });

  it("drops a filter key of the wrong shape and keeps the rest of the page", () => {
    expect(viewFromSearch(filterSearch({ tools: "shell" }))).toEqual({ view: EMPTY_VIEW, partial: true });
  });

  it("falls back to the default sort for a sort key core does not have", () => {
    const { view, partial } = viewFromSearch("?sort=age");
    expect([view.sort, partial]).toEqual(["name", true]);
  });

  it("falls back to the default direction for a direction core does not have", () => {
    const { view, partial } = viewFromSearch("?dir=up");
    expect([view.dir, partial]).toEqual(["asc", true]);
  });

  it("drops a search longer than core would accept", () => {
    const { view, partial } = viewFromSearch(`?q=${repeat(101)}`);
    expect([view.q, partial]).toEqual(["", true]);
  });

  // `?q=` is a box that was cleared, not a value that was refused: nothing to report.
  it("reads an empty search as a cleared box rather than a dropped value", () => {
    expect(viewFromSearch("?q=")).toEqual({ view: EMPTY_VIEW, partial: false });
  });

  it("drops a model alternative whose effort is not a string", () => {
    const { view, partial } = viewFromSearch(filterSearch({ models: [{ model: "opus-5", effort: 123 }] }));
    expect([view.models, partial]).toEqual([[], true]);
  });

  it("drops a model alternative whose effort is longer than core would accept, whole", () => {
    const { view, partial } = viewFromSearch(filterSearch({ models: [{ model: "opus-5", effort: repeat(33) }] }));
    expect([view.models, partial]).toEqual([[], true]);
  });

  it("drops a model with no name", () => {
    const { view, partial } = viewFromSearch(filterSearch({ models: [{ model: "" }] }));
    expect([view.models, partial]).toEqual([[], true]);
  });

  it("drops a model name longer than core would accept", () => {
    const { view, partial } = viewFromSearch(filterSearch({ models: [{ model: repeat(101) }] }));
    expect([view.models, partial]).toEqual([[], true]);
  });

  it("drops the model entries that are not objects and keeps the one that is", () => {
    const { view, partial } = viewFromSearch(filterSearch({ models: [{ model: "a" }, "nope", null] }));
    expect([view.models, partial]).toEqual([[{ model: "a" }], true]);
  });

  it("keeps the first 20 models and says the link asked for more", () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ model: `m-${i}` }));
    const { view, partial } = viewFromSearch(filterSearch({ models: many }));
    expect([view.models, partial]).toEqual([many.slice(0, 20), true]);
  });

  it("keeps the first 50 tools and says the link asked for more", () => {
    const many = Array.from({ length: 51 }, (_, i) => `t-${i}`);
    const { view, partial } = viewFromSearch(filterSearch({ tools: many }));
    expect([view.tools, partial]).toEqual([many.slice(0, 50), true]);
  });

  // The rule the whole parser turns on: an entry thrown away is thrown away out loud, so the
  // "part of this link was not understood" line appears rather than a link that quietly lies.
  it("keeps the good tools and still reports the empty one it discarded", () => {
    expect(viewFromSearch(filterSearch({ tools: ["shell", ""] })))
      .toEqual({ view: { ...EMPTY_VIEW, tools: ["shell"] }, partial: true });
  });

  it("drops a tool longer than core would accept and keeps the others", () => {
    const { view, partial } = viewFromSearch(filterSearch({ tools: ["shell", repeat(65)] }));
    expect([view.tools, partial]).toEqual([["shell"], true]);
  });

  it("drops a tool that is not a string and keeps the others", () => {
    const { view, partial } = viewFromSearch(filterSearch({ tools: ["shell", 5] }));
    expect([view.tools, partial]).toEqual([["shell"], true]);
  });

  it("drops an empty runtime", () => {
    const { view, partial } = viewFromSearch(filterSearch({ runtime: "" }));
    expect([view.runtime, partial]).toEqual([undefined, true]);
  });

  it("drops a runtime longer than core would accept", () => {
    const { view, partial } = viewFromSearch(filterSearch({ runtime: repeat(65) }));
    expect([view.runtime, partial]).toEqual([undefined, true]);
  });

  it("drops a runtime that is not a string", () => {
    const { view, partial } = viewFromSearch(filterSearch({ runtime: 5 }));
    expect([view.runtime, partial]).toEqual([undefined, true]);
  });

  it("drops a serving policy that is not one of the three words", () => {
    const { view, partial } = viewFromSearch(filterSearch({ serves: "nobody" }));
    expect([view.serves, partial]).toEqual([undefined, true]);
  });

  it("drops a serving policy that is not a string", () => {
    const { view, partial } = viewFromSearch(filterSearch({ serves: 5 }));
    expect([view.serves, partial]).toEqual([undefined, true]);
  });

  // Core's schema is `.strict()`, so a key it does not know is `validation` rather than something
  // it quietly ignores — and "nothing is dropped silently" applies to a key as much as to a value.
  it("reports a filter key core does not have, and keeps the ones it does", () => {
    expect(viewFromSearch(filterSearch({ tools: ["shell"], owner: "ada" })))
      .toEqual({ view: { ...EMPTY_VIEW, tools: ["shell"] }, partial: true });
  });

  // Dropped whole, for the reason a bad `effort` is: keeping `{ model }` out of it would silently
  // answer a wider question than the link asked.
  it("drops a model alternative carrying a key core does not have, whole", () => {
    const { view, partial } = viewFromSearch(filterSearch({ models: [{ model: "opus-5", temperature: 1 }] }));
    expect([view.models, partial]).toEqual([[], true]);
  });
});

/**
 * Core answers a **NUL** in any of these with `validation` (`listeners-input.ts`): \u0000 is the
 * one character a Postgres text parameter and a jsonb value cannot carry. A link holding one must
 * be read here rather than forwarded — forwarding it turns a hand-edited `?q=a%00b` into core's 400
 * and an error page, which is the one thing §5.4 says must not happen. Written as an escape, never
 * as a literal byte.
 */
describe("a link carrying the one character core cannot store (spec §5.4)", () => {
  const NUL = "a\u0000b";

  it("drops a search carrying a NUL", () => {
    const { view, partial } = viewFromSearch(`?q=${encodeURIComponent(NUL)}`);
    expect([view.q, partial]).toEqual(["", true]);
  });

  it("drops a tool carrying one and keeps the others", () => {
    const { view, partial } = viewFromSearch(filterSearch({ tools: ["shell", NUL] }));
    expect([view.tools, partial]).toEqual([["shell"], true]);
  });

  it("drops a runtime carrying one", () => {
    const { view, partial } = viewFromSearch(filterSearch({ runtime: NUL }));
    expect([view.runtime, partial]).toEqual([undefined, true]);
  });

  it("drops a model name carrying one", () => {
    const { view, partial } = viewFromSearch(filterSearch({ models: [{ model: NUL }] }));
    expect([view.models, partial]).toEqual([[], true]);
  });

  it("drops a model alternative whose effort carries one, whole", () => {
    const { view, partial } = viewFromSearch(filterSearch({ models: [{ model: "opus-5", effort: NUL }] }));
    expect([view.models, partial]).toEqual([[], true]);
  });
});

/**
 * Every **other** control character is one core accepts and the directory really emits.
 * `validateProfile` stores a tab or a newline inside an `owner`, a tool, a runtime, a model or an
 * effort, and Postgres matches it — so such a value arrives on a facet chip and inside a cursor.
 * Dropping it here would leave the page unable to read a link it wrote itself, and would report a
 * perfectly good link as "not understood" (PR #20 review round 1).
 */
describe("a link carrying a tab or a newline inside a value (spec §5.4)", () => {
  it("keeps a search carrying a tab", () => {
    const { view, partial } = viewFromSearch(`?q=${encodeURIComponent("a\tb")}`);
    expect([view.q, partial]).toEqual(["a\tb", false]);
  });

  it("keeps a tool carrying a tab", () => {
    const { view, partial } = viewFromSearch(filterSearch({ tools: ["a\tb"] }));
    expect([view.tools, partial]).toEqual([["a\tb"], false]);
  });

  it("keeps a runtime carrying a newline", () => {
    const { view, partial } = viewFromSearch(filterSearch({ runtime: "a\nb" }));
    expect([view.runtime, partial]).toEqual(["a\nb", false]);
  });

  it("keeps a model name carrying a tab", () => {
    const { view, partial } = viewFromSearch(filterSearch({ models: [{ model: "a\tb" }] }));
    expect([view.models, partial]).toEqual([[{ model: "a\tb" }], false]);
  });

  it("keeps a model effort carrying a newline", () => {
    const { view, partial } = viewFromSearch(filterSearch({ models: [{ model: "opus-5", effort: "a\nb" }] }));
    expect([view.models, partial]).toEqual([[{ model: "opus-5", effort: "a\nb" }], false]);
  });

  // The page writes this link itself, out of a facet chip it was handed: what it writes it must read.
  it("round-trips a view whose every value carries a tab or a newline", () => {
    const view: ListenersView = {
      q: "a\tb", models: [{ model: "m\tx", effort: "e\ny" }], tools: ["t\tu"],
      runtime: "r\nv", serves: "anyone", sort: "owner", dir: "desc",
    };
    expect(viewFromSearch(`?${searchFromView(view)}`)).toEqual({ view, partial: false });
  });
});

describe("the query a view asks core for (spec §5.3)", () => {
  it("asks for a page of 50 when the caller names no limit", () => {
    expect(queryFromView(EMPTY_VIEW, {})).toEqual({ sort: "name", dir: "asc", limit: 50 });
  });

  it("carries the cursor when Show more gives it one", () => {
    expect(queryFromView(EMPTY_VIEW, { cursor: "abc" }).cursor).toBe("abc");
  });

  it("leaves out a cleared search box: an empty q is no search, not a blank one", () => {
    expect("q" in queryFromView({ ...EMPTY_VIEW, q: "" }, {})).toBe(false);
  });

  it("leaves out the filters that are not set, and carries the ones that are", () => {
    expect(queryFromView(FULL, {})).toEqual({
      q: "fable", models: FULL.models, tools: FULL.tools, runtime: "node", serves: "anyone",
      sort: "owner", dir: "desc", limit: 50,
    });
  });

  it("leaves out an empty chip row: no chips is no filter, not a filter matching nothing", () => {
    const q = queryFromView({ ...EMPTY_VIEW, runtime: "node" }, {});
    expect(["models" in q, "tools" in q]).toEqual([false, false]);
  });
});

/**
 * The one place the directory touches the history API (spec §5.4, and the plan's file-structure
 * table, which puts this rule beside the codec that writes the string). It is narrow on purpose:
 * rewriting the query string of the page you are already on names the same page, and every other
 * case — another path, an in-place render — names one this browser might not be able to load again.
 */
describe("the one replaceState rule (spec §5.4)", () => {
  const NODE = { ...EMPTY_VIEW, runtime: "node" };
  const at = (url: string) => history.replaceState(null, "", url);
  const filterOf = () => new URLSearchParams(location.search).get("filter");
  afterEach(() => { vi.restoreAllMocks(); });

  it("rewrites the query string of the page it is on", () => {
    at("/lobby/listeners");
    const replaced = vi.spyOn(history, "replaceState");
    writeSearch(NODE);
    expect([replaced.mock.calls.length, filterOf()]).toEqual([1, '{"runtime":"node"}']);
  });

  it("rewrites it with the trailing slash too, as the server serves both", () => {
    at("/lobby/listeners/");
    const replaced = vi.spyOn(history, "replaceState");
    writeSearch(NODE);
    expect([replaced.mock.calls.length, location.pathname]).toEqual([1, "/lobby/listeners/"]);
  });

  // An exact comparison, not a `startsWith`: the query string of some other page that merely begins
  // the same way is not this page's to rewrite.
  it("leaves another page's query string alone", () => {
    at("/lobby/listenersx");
    const replaced = vi.spyOn(history, "replaceState");
    writeSearch(NODE);
    expect([replaced.mock.calls.length, location.search]).toEqual([0, ""]);
  });

  it("writes nothing when the string it would write is the one already there", () => {
    at("/lobby/listeners");
    writeSearch(NODE);
    const replaced = vi.spyOn(history, "replaceState");
    writeSearch(NODE);
    expect(replaced.mock.calls.length).toBe(0);
  });

  it("never pushes a history entry: ten keystrokes are not ten back-button steps", () => {
    at("/lobby/listeners");
    const pushed = vi.spyOn(history, "pushState");
    writeSearch(NODE);
    writeSearch(EMPTY_VIEW);
    expect(pushed.mock.calls.length).toBe(0);
  });
});

/**
 * The Lobby's two addresses, in the module `app.tsx` and `WeaveView` share (spec §4.1). They live
 * here rather than in a file of their own because `lobby-view.ts` is a twenty-line module and
 * `writeSearch`'s own path test is already above, so all of the feature's path rules read together.
 */
describe("the Lobby's two addresses (spec §4.1)", () => {
  it("names the directory for both spellings the server serves", () => {
    expect([viewOfPath("/lobby/listeners"), viewOfPath("/lobby/listeners/")]).toEqual(["listeners", "listeners"]);
  });

  it("names the thread for both spellings of the Lobby", () => {
    expect([viewOfPath("/lobby"), viewOfPath("/lobby/")]).toEqual(["thread", "thread"]);
  });

  it("says nothing at all about a path that is not the Lobby's", () => {
    expect([viewOfPath("/"), viewOfPath("/lobby/listenersx"), viewOfPath("/weave/x")])
      .toEqual([undefined, undefined, undefined]);
  });

  it("writes one canonical spelling, never a trailing slash", () => {
    expect([pathForView("thread"), pathForView("listeners")]).toEqual(["/lobby", "/lobby/listeners"]);
  });
});
