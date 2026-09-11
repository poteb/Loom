import { useEffect, useMemo, useState } from "preact/hooks";
import { LoomClient } from "@loom/client";
import { createSession, type Session, type SessionState } from "./session.js";
import { browserStorage } from "./storage.js";

export function useSession(secret: string): { session: Session; state: SessionState } {
  const session = useMemo(() => {
    const client = new LoomClient({ baseUrl: location.origin, allowInsecure: location.protocol === "http:" });
    return createSession({ client, secret, storage: browserStorage() });
  }, [secret]);
  const [state, setState] = useState<SessionState>(session.getState());
  useEffect(() => {
    const off = session.subscribe(() => setState(session.getState()));
    void session.load();
    return () => { off(); session.dispose(); };
  }, [session]);
  return { session, state };
}
