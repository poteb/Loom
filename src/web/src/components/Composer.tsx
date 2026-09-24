import { useEffect, useId, useRef, useState } from "preact/hooks";
import type { SessionState } from "../session.js";
import { applyMention, clampSelection, completeMention } from "./mention-logic.js";

export function Composer({ state, onSend, draft }: { state: SessionState; onSend: (text: string) => Promise<void>; draft?: string }) {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const names = state.participants.map((p) => p.name);
  const mention = completeMention(text, caret, names);
  const query = mention?.query;
  // A new query means a new list: the highlight starts at the top again, and an Escape that hid the
  // old list does not keep hiding the new one.
  useEffect(() => { setSelected(0); setDismissed(false); }, [query]);
  const suggestions = mention && !dismissed ? names.filter((n) => n.toLowerCase().startsWith(mention.query.toLowerCase())).slice(0, 6) : [];
  // `selected` is state, so it can still be one render behind the list it indexes into.
  const active = clampSelection(selected, suggestions.length);
  const thread = state.threads.find((t) => t.id === state.currentThreadId);
  const disabled = !thread || !!thread.closedAt;

  // A draft handed back by the app (a send that failed after joining) is restored rather than lost.
  useEffect(() => {
    if (!draft) return;
    setText(draft);
    setCaret(draft.length);
  }, [draft]);

  const pick = (name: string | undefined) => {
    if (!mention || !name) return;
    const r = applyMention(text, mention.start, caret, name);
    setText(r.text); setCaret(r.caret); setSelected(0);
    requestAnimationFrame(() => { ta.current?.focus(); ta.current?.setSelectionRange(r.caret, r.caret); });
  };
  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try { await onSend(t); setText(""); setCaret(0); } catch { /* app shows the error / name prompt */ } finally { setBusy(false); }
  };
  const onKey = (e: KeyboardEvent) => {
    if (suggestions.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSelected((s) => (clampSelection(s, suggestions.length) + 1) % suggestions.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSelected((s) => (clampSelection(s, suggestions.length) - 1 + suggestions.length) % suggestions.length); return; }
      if (e.key === "Tab" || e.key === "Enter") { e.preventDefault(); pick(suggestions[active]); return; }
      if (e.key === "Escape") { e.preventDefault(); setDismissed(true); setSelected(0); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
  };
  const sync = (el: HTMLTextAreaElement) => { setText(el.value); setCaret(el.selectionStart ?? el.value.length); };

  const target = thread ? `Message #${thread.name}` : "Message";

  return (
    <div class="composer">
      {suggestions.length > 0 && (
        <ul class="suggest">
          {suggestions.map((n, i) => <li key={n} class={i === active ? "active" : ""} onMouseDown={(e) => { e.preventDefault(); pick(n); }}>@{n}</li>)}
        </ul>
      )}
      <div class="composer-box">
        <label for={id} class="visually-hidden">{target}</label>
        <textarea id={id} ref={ta} class="composer-input" value={text} disabled={disabled} rows={3}
          placeholder={disabled ? "This thread is closed" : `${target}, @name to mention`}
          onInput={(e) => sync(e.target as HTMLTextAreaElement)} onKeyUp={(e) => sync(e.target as HTMLTextAreaElement)}
          onClick={(e) => sync(e.target as HTMLTextAreaElement)} onKeyDown={onKey} />
        <div class="composer-foot">
          <span class="muted composer-hint">Markdown · <span class="kbd">Enter</span> send · <span class="kbd">Shift Enter</span> newline</span>
          <div class="spacer" />
          <button type="button" class="btn btn-primary composer-send" onClick={() => void send()} disabled={disabled || busy || !text.trim()}>Send</button>
        </div>
      </div>
    </div>
  );
}
