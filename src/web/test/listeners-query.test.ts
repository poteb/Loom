import { describe, it, expect } from "vitest";
import {
  EMPTY_VIEW, queryFromView, searchFromView, viewFromSearch, type ListenersView,
} from "../src/components/listeners/listeners-query.js";

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
});

/**
 * Core answers a C0 character in any of these with `validation` (`listeners-input.ts:69, 91, 112`):
 * `\u0000` cannot travel in a Postgres text parameter or in jsonb at all, and the rest of C0 names
 * no model, tool, runtime or owner. A link carrying one must therefore be read here, not forwarded —
 * otherwise a hand-edited `?q=a%01b` renders core's 400 as an error page, which is exactly what
 * §5.4 says must not happen. Written as escapes, never as literal bytes.
 */
describe("a link carrying characters core cannot store (spec §5.4)", () => {
  const CTRL = "a\u0001b";

  it("drops a search carrying a control character", () => {
    const { view, partial } = viewFromSearch(`?q=${encodeURIComponent(CTRL)}`);
    expect([view.q, partial]).toEqual(["", true]);
  });

  it("drops a tool carrying one and keeps the others", () => {
    const { view, partial } = viewFromSearch(filterSearch({ tools: ["shell", CTRL] }));
    expect([view.tools, partial]).toEqual([["shell"], true]);
  });

  it("drops a runtime carrying one", () => {
    const { view, partial } = viewFromSearch(filterSearch({ runtime: CTRL }));
    expect([view.runtime, partial]).toEqual([undefined, true]);
  });

  it("drops a model name carrying one", () => {
    const { view, partial } = viewFromSearch(filterSearch({ models: [{ model: CTRL }] }));
    expect([view.models, partial]).toEqual([[], true]);
  });

  it("drops a model alternative whose effort carries one, whole", () => {
    const { view, partial } = viewFromSearch(filterSearch({ models: [{ model: "opus-5", effort: CTRL }] }));
    expect([view.models, partial]).toEqual([[], true]);
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
