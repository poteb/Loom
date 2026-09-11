import { useRef, useState } from "preact/hooks";
import type { SessionState } from "../session.js";
import { applyMention, completeMention } from "./mention-logic.js";

export function Composer({ state, onSend }: { state: SessionState; onSend: (text: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(0);
  const ta = useRef<HTMLTextAreaElement>(null);
  const names = state.participants.map((p) => p.name);
  const mention = completeMention(text, caret, names);
  const suggestions = mention ? names.filter((n) => n.toLowerCase().startsWith(mention.query.toLowerCase())).slice(0, 6) : [];
  const thread = state.threads.find((t) => t.id === state.currentThreadId);
  const disabled = !thread || !!thread.closedAt;

  const pick = (name: string) => {
    if (!mention) return;
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
      if (e.key === "ArrowDown") { e.preventDefault(); setSelected((s) => (s + 1) % suggestions.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSelected((s) => (s - 1 + suggestions.length) % suggestions.length); return; }
      if (e.key === "Tab" || e.key === "Enter") { e.preventDefault(); pick(suggestions[selected]!); return; }
      if (e.key === "Escape") { setSelected(0); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
  };
  const sync = (el: HTMLTextAreaElement) => { setText(el.value); setCaret(el.selectionStart ?? el.value.length); };

  return (
    <div class="composer">
      {suggestions.length > 0 && (
        <ul class="suggest">
          {suggestions.map((n, i) => <li key={n} class={i === selected ? "active" : ""} onMouseDown={(e) => { e.preventDefault(); pick(n); }}>@{n}</li>)}
        </ul>
      )}
      <textarea ref={ta} value={text} disabled={disabled} rows={3}
        placeholder={disabled ? "This thread is closed" : "Write a message (Markdown, @name to mention, Enter to send)"}
        onInput={(e) => sync(e.target as HTMLTextAreaElement)} onKeyUp={(e) => sync(e.target as HTMLTextAreaElement)}
        onClick={(e) => sync(e.target as HTMLTextAreaElement)} onKeyDown={onKey} />
      <button onClick={() => void send()} disabled={disabled || busy || !text.trim()}>Send</button>
    </div>
  );
}
