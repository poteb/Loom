import type { FacetValue, ModelFacet } from "@loom/client";

/**
 * One row of chips, with its counts and its selected state.
 *
 * Two rules the row states **in words** rather than implying by chip colour: `models` is any-of and
 * `tools` is all-of, which is the single most confusable thing on this page (spec §5.3). The caller
 * supplies the sentence.
 *
 * A **selected** chip is always on screen, including at a count of `0` — the facets are
 * selection-inclusive for exactly this reason (§2.7). It is the filter that produced the empty
 * result, so hiding it would leave nothing to unclick, and it is the only chip that can show a zero.
 */
export function FacetChips({ label, hint, values, more, selected, onToggle, labelOf, atCap }: {
  label: string;
  /** "any of these", "all of these", "one of these": the row's semantics, said out loud. */
  hint: string;
  values: FacetValue[];
  /** The facet was cut at 20; there are others (spec §2.7). */
  more: boolean;
  selected: readonly string[];
  onToggle: (value: string) => void;
  /** For `serves`, whose three stored words read better as a sentence than as an enum. */
  labelOf?: (value: string) => string;
  /** Set when this row has as many values picked as core will accept, and says so: the sentence is
   *  the disabled chip's `title`. Only the **unselected** chips are refused — at the cap, taking
   *  one off is the only move that gets anywhere, so a picked chip stays live. */
  atCap?: string;
}) {
  if (values.length === 0) return null;
  return (
    <div class="facet">
      <span class="facet-label">{label}</span>
      <span class="facet-hint">{hint}</span>
      <ul class="chips">
        {values.map((v) => {
          const on = selected.includes(v.value);
          return (
          <li key={v.value}>
            <button type="button" class={`chip${on ? " chip-on" : ""}`}
              aria-pressed={on} onClick={() => onToggle(v.value)}
              disabled={atCap !== undefined && !on} title={atCap !== undefined && !on ? atCap : undefined}>
              {labelOf ? labelOf(v.value) : v.value} <span class="chip-count">{v.count}</span>
            </button>
          </li>
          );
        })}
      </ul>
      {more && <span class="facet-more">20 most common</span>}
    </div>
  );
}

/**
 * The models row, which is the one facet with a second level: selecting a model reveals **its**
 * efforts beneath it, and picking one turns that alternative from `{ model }` into the exact pair
 * `{ model, effort }` (spec §5.3). `effort` is free text, so that row is bounded exactly like the
 * outer ones and says so when it was cut.
 */
export function ModelChips({ facet, selected, onToggleModel, onToggleEffort, atCap }: {
  facet: { values: ModelFacet[]; more: boolean };
  selected: readonly { model: string; effort?: string }[];
  onToggleModel: (model: string) => void;
  onToggleEffort: (model: string, effort: string) => void;
  /** As `FacetChips`' own: the sentence a chip refused at core's cap wears. An effort chip is never
   *  refused — picking one narrows an alternative this view already has, it adds none. */
  atCap?: string;
}) {
  if (facet.values.length === 0) return null;
  return (
    <div class="facet">
      <span class="facet-label">models</span>
      <span class="facet-hint">any of these</span>
      <ul class="chips">
        {facet.values.map((m) => {
          const pick = selected.find((s) => s.model === m.model);
          return (
            <li key={m.model}>
              <button type="button" class={`chip${pick ? " chip-on" : ""}`} aria-pressed={!!pick}
                onClick={() => onToggleModel(m.model)}
                disabled={atCap !== undefined && !pick} title={atCap !== undefined && !pick ? atCap : undefined}>
                {m.model} <span class="chip-count">{m.count}</span>
              </button>
              {pick && m.efforts.length > 0 && (
                <ul class="chips chips-effort">
                  {m.efforts.map((e) => (
                    <li key={e.value}>
                      <button type="button" class={`chip${pick.effort === e.value ? " chip-on" : ""}`}
                        aria-pressed={pick.effort === e.value}
                        onClick={() => onToggleEffort(m.model, e.value)}>
                        {e.value} <span class="chip-count">{e.count}</span>
                      </button>
                    </li>
                  ))}
                  {m.moreEfforts && <li class="facet-more">10 most common</li>}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {facet.more && <span class="facet-more">20 most common</span>}
    </div>
  );
}
