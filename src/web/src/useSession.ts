import { useEffect, useMemo, useState } from "preact/hooks";
import type { LoomClient } from "@loom/client";
import { createSession, type Session, type SessionState } from "./session.js";
import type { KeyValueStorage, WriteResult } from "./storage.js";

/**
 * One session's lifetime. It constructs nothing of its own any more: the client and the one storage
 * instance come from the app root (spec §2.4a), so a rebuilt session keeps the same store — which
 * is what lets a credential written to memory survive the rebuild.
 */
export function useSession(
  secret: string,
  deps: { client: LoomClient; storage: KeyValueStorage; onWrite?: (r: WriteResult) => void },
): { session: Session; state: SessionState } {
  const { client, storage, onWrite } = deps;
  const session = useMemo(() => createSession({ client, secret, storage, onWrite }), [secret, client, storage]);
  const [state, setState] = useState<SessionState>(session.getState());
  useEffect(() => {
    const off = session.subscribe(() => setState(session.getState()));
    void session.load();
    return () => { off(); session.dispose(); };
  }, [session]);
  return { session, state };
}
