import { useEffect, useState } from "preact/hooks";
import type { LoomClient } from "@loom/client";
import { renderMarkdown } from "../../markdown.js";

/** Past this many lines the text is collapsed behind a control (spec §4.3). */
const COLLAPSE_LINES = 12;

type Cell = { kind: "loading" } | { kind: "text"; text: string } | { kind: "error"; message: string };

/**
 * What this instance tells every agent (spec §4.3), read from the public `GET /api/guidelines` —
 * no credential, so it is on screen for an anonymous visitor.
 *
 * One of the main page's four independent cells: it fails on its own line and takes nothing else
 * with it. An instance with no guidelines renders **no section at all** rather than an empty box.
 */
export function InstanceGuidelines({ client }: { client: LoomClient }) {
  const [cell, setCell] = useState<Cell>({ kind: "loading" });
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    let live = true;
    client.getInstanceGuidelines().then(
      (text) => { if (live) setCell({ kind: "text", text }); },
      (e: unknown) => { if (live) setCell({ kind: "error", message: e instanceof Error ? e.message : String(e) }); },
    );
    return () => { live = false; };
  }, [client]);

  if (cell.kind === "loading") return null;
  if (cell.kind === "error") return <section class="main-guidelines"><p class="error">{cell.message}</p></section>;
  const text = cell.text.trim();
  if (!text) return null;
  // Collapsed by source line, not by rendered height: the text is Markdown, so the line the human
  // wrote is the unit they will recognise, and slicing it keeps the renderer's own escaping intact.
  const lines = text.split("\n");
  const collapsed = lines.length > COLLAPSE_LINES && !expanded;
  const shown = collapsed ? lines.slice(0, COLLAPSE_LINES).join("\n") : text;
  return (
    <section class="main-guidelines">
      <h2>Guidelines</h2>
      {/* The one Markdown on this page, through the renderer that escapes every tag and keeps only
          http(s)/mailto hrefs. No mentions to resolve here: this text belongs to no Weave. */}
      <div class="main-guidelines-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(shown, [], []) }} />
      {collapsed && <button type="button" onClick={() => setExpanded(true)}>Show all</button>}
    </section>
  );
}
