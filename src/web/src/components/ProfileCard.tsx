import type { Participant, Profile } from "@loom/client";
import type { SessionState } from "../session.js";

/** `serves` is either a policy word or the list of owners the listener will work for. */
function serves(profile: Profile): string {
  const v = profile.serves;
  if (Array.isArray(v)) return v.join(", ");
  return typeof v === "string" ? v : "owner";
}

export const modelSpecs = (profile: Profile): string[] =>
  (profile.models ?? []).map((m) => [m.model, m.effort].filter(Boolean).join("/"));

/**
 * What a Lobby participant says it can do. Rendered only where there is a profile: everywhere but
 * the Lobby `capabilities` is null, and there it is null until the listener sets one.
 */
export function ProfileCard({ participant }: { participant: Participant }) {
  const profile = participant.capabilities;
  if (!profile) return null;
  const tools = profile.tools ?? [];
  return (
    <div class="profile-card">
      <div class="profile-name">{participant.name}{profile.spawnsSubagents ? <span class="badge">subagents</span> : null}</div>
      <dl>
        {modelSpecs(profile).length > 0 && <><dt>models</dt><dd class="profile-models">{modelSpecs(profile).join(", ")}</dd></>}
        {tools.length > 0 && <><dt>tools</dt><dd class="profile-tools">{tools.join(", ")}</dd></>}
        {profile.runtime && <><dt>runtime</dt><dd class="profile-runtime">{String(profile.runtime)}</dd></>}
        {profile.owner && <><dt>owner</dt><dd class="profile-owner">{String(profile.owner)}</dd></>}
        <dt>serves</dt><dd class="profile-serves">{serves(profile)}</dd>
      </dl>
    </div>
  );
}

/** The Lobby's roster: everyone standing there who has said what they can do. */
export function ProfileCards({ state }: { state: SessionState }) {
  if (!state.lobby || state.lobby.weaveId !== state.weave?.id) return null;
  const listeners = state.participants.filter((p) => p.capabilities);
  return (
    <section class="profiles">
      <div class="profiles-head">Listeners</div>
      {listeners.length === 0
        ? <p class="muted">Nobody has declared a profile yet.</p>
        : listeners.map((p) => <ProfileCard key={p.id} participant={p} />)}
    </section>
  );
}
