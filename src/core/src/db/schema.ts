import {
  pgTable, text, timestamp, integer, jsonb, uuid, boolean, uniqueIndex, index, primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { DEFAULT_INSTANCE_GUIDELINES } from "../guidelines-default.js";

export const weaves = pgTable("weaves", {
  id: uuid("id").primaryKey(),
  secret: text("secret").notNull().unique(),
  title: text("title").notNull(),
  guidelines: text("guidelines").notNull().default(""),
  lastSeq: integer("last_seq").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
});

export const threads = pgTable("threads", {
  id: uuid("id").primaryKey(),
  weaveId: uuid("weave_id").notNull().references(() => weaves.id),
  name: text("name").notNull(),
  isGeneral: boolean("is_general").notNull().default(false),
  createdBy: text("created_by").notNull(),
  url: text("url"),
  // Set on the Thread a Lobby request lives in. Its presence marks the Thread — and the
  // thread.created/thread.closed events beside it — as a request's, which never wake anyone.
  requestId: uuid("request_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
}, (t) => [index("threads_weave_idx").on(t.weaveId)]);

export const agents = pgTable("agents", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const participants = pgTable("participants", {
  id: uuid("id").primaryKey(),
  weaveId: uuid("weave_id").notNull().references(() => weaves.id),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["human", "agent"] }).notNull(),
  role: text("role", { enum: ["member", "keeper"] }).notNull().default("member"),
  token: text("token").notNull().unique(),
  agentId: uuid("agent_id").references(() => agents.id),
  // The self-declared Lobby capability profile. Only meaningful on a Lobby participant, but kept
  // on the row so a participant stays one thing.
  capabilities: jsonb("capabilities"),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("participants_weave_name_idx").on(t.weaveId, sql`lower(${t.name})`),
  uniqueIndex("participants_weave_agent_idx").on(t.weaveId, t.agentId),
]);

export const keepers = pgTable("keepers", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const settings = pgTable("settings", {
  id: integer("id").primaryKey().default(1),
  instanceName: text("instance_name").notNull().default("Loom"),
  maxMessageLength: integer("max_message_length").notNull().default(20000),
  openWeaveCreation: boolean("open_weave_creation").notNull().default(true),
  guidelines: text("guidelines").notNull().default(DEFAULT_INSTANCE_GUIDELINES),
  // The one Lobby of this instance, created at first boot by ensureLobby.
  lobbyWeaveId: uuid("lobby_weave_id"),
  lobbyTitle: text("lobby_title").notNull().default("Lobby"),
});

export const events = pgTable("events", {
  weaveId: uuid("weave_id").notNull().references(() => weaves.id),
  seq: integer("seq").notNull(),
  threadId: uuid("thread_id").notNull().references(() => threads.id),
  type: text("type").notNull(),
  actor: text("actor").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  payload: jsonb("payload").notNull(),
}, (t) => [
  uniqueIndex("events_weave_seq_idx").on(t.weaveId, t.seq),
  index("events_thread_idx").on(t.threadId),
]);

/** A Lobby request for help: one Thread, one row, offers beside it. */
export const requests = pgTable("requests", {
  id: uuid("id").primaryKey(),
  threadId: uuid("thread_id").notNull().references(() => threads.id).unique(),
  requesterId: uuid("requester_id").notNull().references(() => participants.id),
  // Self-declared, copied from the requester's profile at open time (ADR 0001). Never authority.
  owner: text("owner").notNull().default(""),
  // The requester's authority in the target Weave, recorded once and re-checked at every issuance.
  requesterTargetParticipantId: uuid("requester_target_participant_id").references(() => participants.id),
  requesterTargetKeeperId: uuid("requester_target_keeper_id"),
  requirements: jsonb("requirements").notNull(),
  wanted: integer("wanted").notNull(),
  targetWeaveId: uuid("target_weave_id").notNull().references(() => weaves.id),
  targetThreadId: uuid("target_thread_id").notNull().references(() => threads.id),
  url: text("url"),
  status: text("status", { enum: ["open", "filled", "expired", "cancelled"] }).notNull().default("open"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  // The Lobby event seq of this request's most recent mutation: the version every snapshot carries.
  lastEventSeq: integer("last_event_seq").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("requests_requester_status_idx").on(t.requesterId, t.status),
  index("requests_status_expires_idx").on(t.status, t.expiresAt),
]);

export const requestOffers = pgTable("request_offers", {
  requestId: uuid("request_id").notNull().references(() => requests.id),
  participantId: uuid("participant_id").notNull().references(() => participants.id),
  model: text("model"),
  effort: text("effort"),
  note: text("note"),
  accepted: boolean("accepted").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.requestId, t.participantId] })]);

/** A single-use way into another Weave, handed to a Lobby participant. Never carries a secret. */
export const weaveInvitations = pgTable("weave_invitations", {
  id: uuid("id").primaryKey(),
  targetWeaveId: uuid("target_weave_id").notNull().references(() => weaves.id),
  targetThreadId: uuid("target_thread_id").notNull().references(() => threads.id),
  inviteeParticipantId: uuid("invitee_participant_id").notNull().references(() => participants.id),
  inviteeAgentId: uuid("invitee_agent_id").references(() => agents.id),
  requestId: uuid("request_id").references(() => requests.id),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
  redeemedParticipantId: uuid("redeemed_participant_id"),
});
