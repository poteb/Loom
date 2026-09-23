import type { Participant, Profile } from "@loom/client";

/** `serves` is either a policy word or the list of owners the listener will work for. */
function serves(profile: Profile): string {
  const v = profile.serves;
  if (Array.isArray(v)) return v.join(", ");
  return typeof v === "string" ? v : "owner";
}

export const modelSpecs = (profile: Profile): string[] =>
  (profile.models ?? []).map((m) => [m.model, m.effort].filter(Boolean).join("/"));

/** When the listener was last seen, in whole minutes (under one is 0), or that it never was (spec §5.11). */
export function seenText(lastSeenAt: string | null, nowMs: number): string {
  if (lastSeenAt === null) return "never seen";
  return `seen ${Math.max(0, Math.floor((nowMs - Date.parse(lastSeenAt)) / 60_000))} min ago`;
}

/**
 * What a Lobby participant says it can do. Rendered only where there is a profile, and there is
 * exactly one place that has them to render: the listeners directory, whose rows carry the profile
 * beside the participant (spec §2.1). `getWeave` carries none at all, in the Lobby or out of it.
 */
export function ProfileCard({ participant, now }: { participant: Participant; now?: number }) {
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
      <div class="profile-seen">{seenText(participant.lastSeenAt, now ?? Date.now())}</div>
    </div>
  );
}
