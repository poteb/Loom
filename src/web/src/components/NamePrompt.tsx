import { useState } from "preact/hooks";
import { isValidName } from "../name.js";

export function NamePrompt({ onSubmit, onCancel, error }: { onSubmit: (name: string) => Promise<void>; onCancel: () => void; error?: string }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = isValidName(name);
  const submit = async (e: Event) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    try { await onSubmit(name); } finally { setBusy(false); }
  };
  return (
    <div class="modal-backdrop">
      <form class="modal" onSubmit={submit}>
        <h2>Choose a name</h2>
        <p>1–32 characters: letters, digits, <code>_ . -</code></p>
        <input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} autoFocus maxLength={32} />
        {error && <p class="error">{error}</p>}
        <div class="modal-actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={!valid || busy}>Join</button>
        </div>
      </form>
    </div>
  );
}
