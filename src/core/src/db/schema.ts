import {
  pgTable, text, timestamp, integer, jsonb, uuid, boolean, uniqueIndex, index,
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
