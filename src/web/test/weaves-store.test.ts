import { describe, it, expect, afterEach, vi } from "vitest";
import { LoomClient, LoomClientError } from "@loom/client";
import { browserStorage, memoryStorage, type KeyValueStorage, type WriteResult } from "../src/storage.js";
import { createPersistenceNotice } from "../src/persistence.js";
import {
  forgetWeave, hasIdentity, invalidateIdentity, isCredentialFailure, legacyKey, mergeLegacy,
  migrateLegacy, migrateLegacyOne, readerFor, readWeaveEntry, saveWeaveEntry, setIdentity,
  storedWeaves, weaveKey,
} from "../src/weaves-store.js";

const ID = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
/** A real legacy remainder: 43 base64url characters, no colon. */
const SECRET = "A".repeat(43);
const SECRET2 = "B".repeat(43);

type Mode = "ok" | "throw" | "silent";

/** A localStorage that can refuse writes (blocked site data) or accept them and keep nothing. */
function installLocalStorage() {
  const raw = new Map<string, string>();
  let mode: Mode = "ok";
  const api = {
    getItem: (k: string) => raw.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (mode === "throw") throw new Error("QuotaExceededError");
      if (mode === "silent") return;                       // accepts the call, stores nothing
      raw.set(k, v);
    },
    removeItem: (k: string) => {
      if (mode === "throw") throw new Error("blocked");
      if (mode === "silent") return;
      raw.delete(k);
    },
    key: (i: number) => [...raw.keys()][i] ?? null,
    get length() { return raw.size; },
    clear: () => raw.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", { value: api, configurable: true, writable: true });
  return { raw, api, setMode: (m: Mode) => { mode = m; } };
}
afterEach(() => { Reflect.deleteProperty(globalThis as object, "localStorage"); });

/** A storage that counts its writes, so "one write" can be asserted rather than hoped for. */
function counting(inner: KeyValueStorage = memoryStorage()) {
  let sets = 0;
  let removes = 0;
  const storage: KeyValueStorage = {
    get: (k) => inner.get(k),
    set: (k, v): WriteResult => { sets++; return inner.set(k, v); },
    remove: (k) => { removes++; inner.remove(k); },
    keys: () => inner.keys(),
    isPending: (k) => inner.isPending(k),
  };
  return { storage, sets: () => sets, removes: () => removes };
}

function putLegacy(storage: KeyValueStorage, secret: string, v: { token?: string; participantId?: string }): void {
  storage.set(legacyKey(secret), JSON.stringify(v));
}

describe("storedWeaves", () => {
  it("discriminates an id key from a legacy key on the colon in the remainder", () => {
    const storage = memoryStorage();
    saveWeaveEntry(storage, ID, { title: "T" });
    putLegacy(storage, SECRET, { token: "tok" });
    expect(storedWeaves(storage)).toEqual([
      { kind: "id", weaveId: ID, title: "T" },
      { kind: "legacy", secret: SECRET, token: "tok" },
    ]);
  });

  it("skips a key that is neither shape", () => {
    const storage = memoryStorage();
    storage.set("other:x", JSON.stringify({ token: "tok" }));
    storage.set("loom:weave:", JSON.stringify({ token: "tok" }));   // no weave id
    putLegacy(storage, SECRET, {});                                  // a legacy entry with no token
    expect(storedWeaves(storage)).toEqual([]);
  });

  it("skips a corrupt value instead of failing", () => {
    const storage = memoryStorage();
    storage.set(weaveKey(ID), "{not json");
    saveWeaveEntry(storage, ID2, { title: "T" });
    expect(storedWeaves(storage)).toEqual([{ kind: "id", weaveId: ID2, title: "T" }]);
  });

  // The key is the fact; the value is what the key holds. A stored value that happens to carry
  // `kind` or `weaveId` must not be able to say it is a legacy row, or name a different Weave —
  // `targets()` would then take the legacy branch and look for a secret that is not there.
  it("lets a stored value override neither the discriminator nor the id its key implies", () => {
    const storage = memoryStorage();
    storage.set(weaveKey(ID), JSON.stringify({ kind: "legacy", weaveId: ID2, secret: SECRET, token: "tok" }));
    expect(storedWeaves(storage)).toEqual([{ kind: "id", weaveId: ID, secret: SECRET, token: "tok" }]);
  });

  for (const [label, raw] of [["a bare string", "\"123\""], ["null", "null"], ["an array", "[]"]] as const) {
    it(`skips ${label}, under an id key and a legacy key alike`, () => {
      const storage = memoryStorage();
      storage.set(weaveKey(ID), raw);
      storage.set(legacyKey(SECRET), raw);
      expect(storedWeaves(storage)).toEqual([]);
    });
  }
});

describe("saveWeaveEntry", () => {
  it("merges the patch over what is stored", () => {
    const storage = memoryStorage();
    saveWeaveEntry(storage, ID, { title: "A" });
    saveWeaveEntry(storage, ID, { lastOpenedAt: "t" });
    expect(readWeaveEntry(storage, ID)).toEqual({ title: "A", lastOpenedAt: "t" });
  });

  it("ignores undefined values in the patch", () => {
    const storage = memoryStorage();
    saveWeaveEntry(storage, ID, { title: "A" });
    saveWeaveEntry(storage, ID, { title: undefined, secret: undefined });
    expect(readWeaveEntry(storage, ID)).toEqual({ title: "A" });
  });
});

describe("setIdentity", () => {
  it("writes the identity and removes an existing invalid marker", () => {
    const storage = memoryStorage();
    saveWeaveEntry(storage, ID, { secret: "s" });
    invalidateIdentity(storage, ID);
    setIdentity(storage, ID, { token: "tok", participantId: "p1" });
    expect(readWeaveEntry(storage, ID)).toEqual({ secret: "s", token: "tok", participantId: "p1" });
  });

  it("writes the identity and everything in `extra` in a single write", () => {
    const c = counting();
    setIdentity(c.storage, ID, { token: "tok", participantId: "p1" },
      { secret: "s", title: "T", lastOpenedAt: "t" });
    expect(c.sets()).toBe(1);
    expect(readWeaveEntry(c.storage, ID)).toEqual({
      token: "tok", participantId: "p1", secret: "s", title: "T", lastOpenedAt: "t",
    });
  });

  it("caches the name this browser joined as, in that same single write", () => {
    // The name travels with the identity it belongs to, so nothing has to read it back off the
    // network to say "joined as dana" (spec §4.1, §4.2 — the list paints with no request at all).
    const c = counting();
    setIdentity(c.storage, ID, { token: "tok", participantId: "p1", name: "dana" }, { title: "T" });
    expect([c.sets(), readWeaveEntry(c.storage, ID)])
      .toEqual([1, { token: "tok", participantId: "p1", name: "dana", title: "T" }]);
  });
});

describe("mergeLegacy", () => {
  it("keeps a usable id identity over the legacy one", () => {
    const merged = mergeLegacy({ token: "new", participantId: "pNew" }, { secret: SECRET, token: "old" });
    expect(merged.token).toBe("new");
    expect(merged.participantId).toBe("pNew");
  });

  it("never adopts a legacy identity into an entry marked invalid", () => {
    const merged = mergeLegacy({ identity: "invalid", secret: "s" }, { secret: SECRET, token: "old" });
    expect(merged.token).toBeUndefined();
    expect(merged.identity).toBe("invalid");
  });

  it("adopts the legacy identity when the entry has neither identity nor marker", () => {
    const merged = mergeLegacy({ title: "T" }, { secret: SECRET, token: "old", participantId: "pOld" });
    expect(merged).toEqual({ title: "T", token: "old", participantId: "pOld", secret: SECRET });
  });

  it("carries the legacy secret over when the entry has none", () => {
    expect(mergeLegacy({ token: "new", participantId: "pNew" }, { secret: SECRET, token: "old" }).secret)
      .toBe(SECRET);
  });

  it("does not overwrite a secret the entry already has", () => {
    expect(mergeLegacy({ secret: "mine", token: "new", participantId: "p" }, { secret: SECRET, token: "old" }).secret)
      .toBe("mine");
  });

  it("takes the legacy identity and secret when there is no entry at all", () => {
    expect(mergeLegacy(undefined, { secret: SECRET, token: "old", participantId: "pOld" }))
      .toEqual({ secret: SECRET, token: "old", participantId: "pOld" });
  });
});

describe("readerFor", () => {
  const client = new LoomClient({ baseUrl: "http://localhost:1", allowInsecure: true });

  it("reads with the token when the identity is usable", () => {
    const choice = readerFor(client, { token: "tok", participantId: "p", secret: "s" });
    expect(choice?.withToken).toBe(true);
    expect(choice?.reader.token).toBe("tok");
    expect(choice?.readOnlyReason).toBeUndefined();
  });

  it("falls back to the secret when the identity is invalid", () => {
    const choice = readerFor(client, { identity: "invalid", secret: "s" });
    expect(choice).toMatchObject({ withToken: false, readOnlyReason: "secret-fallback" });
    expect(choice?.reader.token).toBe("s");
  });

  it("reads with the secret when there is no identity at all", () => {
    const choice = readerFor(client, { secret: "s" });
    expect(choice).toMatchObject({ withToken: false, readOnlyReason: "secret-fallback" });
    expect(choice?.reader.token).toBe("s");
  });

  it("offers nothing when this browser holds no credential", () => {
    expect(readerFor(client, { title: "T" })).toBeUndefined();
  });
});

describe("isCredentialFailure", () => {
  it("is true for a 401 or a 403 and false for a network failure", () => {
    expect(isCredentialFailure(new LoomClientError("invalid_token", "no", 401))).toBe(true);
    expect(isCredentialFailure(new LoomClientError("forbidden", "no", 403))).toBe(true);
    expect(isCredentialFailure(new LoomClientError("network", "offline"))).toBe(false);
    expect(isCredentialFailure(new Error("boom"))).toBe(false);
  });
});

describe("migrateLegacyOne", () => {
  it("writes nothing and answers undefined when there is no legacy key", () => {
    const c = counting();
    expect(migrateLegacyOne(c.storage, ID, SECRET)).toBeUndefined();
    expect(c.sets()).toBe(0);
    expect(c.removes()).toBe(0);
  });
});

describe("invalidateIdentity", () => {
  it("deletes the identity, sets the marker and keeps the secret and display cache", () => {
    const storage = memoryStorage();
    saveWeaveEntry(storage, ID, {
      token: "tok", participantId: "p1", secret: "s", title: "T", archived: true, lastOpenedAt: "t",
    });
    invalidateIdentity(storage, ID);
    expect(readWeaveEntry(storage, ID)).toEqual({
      identity: "invalid", secret: "s", title: "T", archived: true, lastOpenedAt: "t",
    });
  });

  it("deletes the name too: it names the identity that just died, not the Weave", () => {
    const storage = memoryStorage();
    saveWeaveEntry(storage, ID, { token: "tok", participantId: "p1", name: "dana", secret: "s", title: "T" });
    invalidateIdentity(storage, ID);
    expect(readWeaveEntry(storage, ID)).toEqual({ identity: "invalid", secret: "s", title: "T" });
  });
});

describe("hasIdentity", () => {
  it("is true only for a token and participant id with no invalid marker", () => {
    expect(hasIdentity({})).toBe(false);
    expect(hasIdentity({ token: "tok", participantId: "p", identity: "invalid" })).toBe(false);
    expect(hasIdentity({ token: "tok", participantId: "p" })).toBe(true);
  });
});

describe("forgetWeave", () => {
  it("removes the entry, and storedWeaves no longer lists it", () => {
    const storage = memoryStorage();
    saveWeaveEntry(storage, ID, { title: "T" });
    forgetWeave(storage, ID);
    expect(readWeaveEntry(storage, ID)).toBeUndefined();
    expect(storedWeaves(storage)).toEqual([]);
  });
});

describe("migrateLegacy", () => {
  const lookupOf = (map: Record<string, string>) => async (secret: string) => {
    const id = map[secret];
    if (!id) throw new Error("unknown secret");
    return id;
  };

  it("rewrites a legacy entry to an id entry and drops the legacy key when the write is durable", async () => {
    const storage = memoryStorage();
    putLegacy(storage, SECRET, { token: "tok", participantId: "p1" });
    await migrateLegacy(storage, createPersistenceNotice(), lookupOf({ [SECRET]: ID }));
    expect(readWeaveEntry(storage, ID)).toEqual({ token: "tok", participantId: "p1", secret: SECRET });
    expect(storage.get(legacyKey(SECRET))).toBeNull();
  });

  it("leaves a rejoined id entry's own token in place over a conflicting legacy duplicate", async () => {
    const storage = memoryStorage();
    setIdentity(storage, ID, { token: "new", participantId: "pNew" });
    putLegacy(storage, SECRET, { token: "old", participantId: "pOld" });
    await migrateLegacy(storage, createPersistenceNotice(), lookupOf({ [SECRET]: ID }));
    expect(readWeaveEntry(storage, ID)?.token).toBe("new");
    expect(storage.get(legacyKey(SECRET))).toBeNull();
  });

  it("does not revive an identity marked invalid, and keeps that entry's secret", async () => {
    const storage = memoryStorage();
    saveWeaveEntry(storage, ID, { token: "dead", participantId: "p1", secret: "mine" });
    invalidateIdentity(storage, ID);
    putLegacy(storage, SECRET, { token: "old", participantId: "pOld" });
    await migrateLegacy(storage, createPersistenceNotice(), lookupOf({ [SECRET]: ID }));
    const entry = readWeaveEntry(storage, ID);
    expect(entry?.token).toBeUndefined();
    expect(entry?.identity).toBe("invalid");
    expect(entry?.secret).toBe("mine");
  });

  it("keeps the legacy key when the id entry only reached memory, and the new entry still reads back", async () => {
    const ls = installLocalStorage();
    ls.raw.set(legacyKey(SECRET), JSON.stringify({ token: "tok", participantId: "p1" }));
    ls.setMode("silent");                                   // accepts every write and keeps nothing
    const storage = browserStorage();
    await migrateLegacy(storage, createPersistenceNotice(), lookupOf({ [SECRET]: ID }));
    expect(readWeaveEntry(storage, ID)?.token).toBe("tok"); // readable on this page
    expect(ls.raw.has(legacyKey(SECRET))).toBe(true);       // still in localStorage
    // A reload: a second storage over the same raw map still finds the legacy identity.
    expect(storedWeaves(browserStorage())).toContainEqual(
      { kind: "legacy", secret: SECRET, token: "tok", participantId: "p1" });
  });

  it("stops the pass once a write has proven the store keeps nothing", async () => {
    const storage = memoryStorage({ durable: false });
    putLegacy(storage, SECRET, { token: "tok1" });
    putLegacy(storage, SECRET2, { token: "tok2" });
    const lookup = vi.fn(lookupOf({ [SECRET]: ID, [SECRET2]: ID2 }));
    await migrateLegacy(storage, createPersistenceNotice(), lookup);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(readWeaveEntry(storage, ID2)).toBeUndefined();
    expect(storage.get(legacyKey(SECRET2))).not.toBeNull();
  });

  it("leaves a legacy entry alone when its lookup rejects, and moves on to the next", async () => {
    const storage = memoryStorage();
    putLegacy(storage, SECRET, { token: "tok1" });
    putLegacy(storage, SECRET2, { token: "tok2" });
    await migrateLegacy(storage, createPersistenceNotice(), lookupOf({ [SECRET2]: ID2 }));
    expect(storage.get(legacyKey(SECRET))).not.toBeNull();
    expect(readWeaveEntry(storage, ID)).toBeUndefined();
    expect(readWeaveEntry(storage, ID2)?.token).toBe("tok2");
  });

  it("calls onChanged once per entry written", async () => {
    const storage = memoryStorage();
    putLegacy(storage, SECRET, { token: "tok1" });
    putLegacy(storage, SECRET2, { token: "tok2" });
    const onChanged = vi.fn();
    await migrateLegacy(storage, createPersistenceNotice(), lookupOf({ [SECRET]: ID, [SECRET2]: ID2 }), onChanged);
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it("does not call onChanged for an entry whose lookup rejected", async () => {
    const storage = memoryStorage();
    putLegacy(storage, SECRET, { token: "tok1" });
    putLegacy(storage, SECRET2, { token: "tok2" });
    const onChanged = vi.fn();
    await migrateLegacy(storage, createPersistenceNotice(), lookupOf({ [SECRET2]: ID2 }), onChanged);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("never calls onChanged when there is no legacy entry", async () => {
    const storage = memoryStorage();
    saveWeaveEntry(storage, ID, { title: "T" });
    const onChanged = vi.fn();
    await migrateLegacy(storage, createPersistenceNotice(), lookupOf({}), onChanged);
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe("readWeaveEntry", () => {
  it("answers undefined for a missing entry and for a corrupt one", () => {
    const storage = memoryStorage();
    expect(readWeaveEntry(storage, ID)).toBeUndefined();
    storage.set(weaveKey(ID), "{not json");
    expect(readWeaveEntry(storage, ID)).toBeUndefined();
  });
});

describe("keys", () => {
  it("spells both key shapes", () => {
    expect(weaveKey(ID)).toBe(`loom:weave:${ID}`);
    expect(legacyKey(SECRET)).toBe(`loom:${SECRET}`);
  });
});
