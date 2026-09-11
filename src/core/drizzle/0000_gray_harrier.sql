CREATE TABLE "events" (
	"weave_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"thread_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "keepers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "keepers_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "participants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"weave_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"token" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "participants_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"instance_name" text DEFAULT 'Loom' NOT NULL,
	"max_message_length" integer DEFAULT 20000 NOT NULL,
	"open_weave_creation" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"weave_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_general" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "weaves" (
	"id" uuid PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"title" text NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "weaves_secret_unique" UNIQUE("secret")
);
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_weave_id_weaves_id_fk" FOREIGN KEY ("weave_id") REFERENCES "public"."weaves"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_weave_id_weaves_id_fk" FOREIGN KEY ("weave_id") REFERENCES "public"."weaves"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_weave_id_weaves_id_fk" FOREIGN KEY ("weave_id") REFERENCES "public"."weaves"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "events_weave_seq_idx" ON "events" USING btree ("weave_id","seq");--> statement-breakpoint
CREATE INDEX "events_thread_idx" ON "events" USING btree ("thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "participants_weave_name_idx" ON "participants" USING btree ("weave_id",lower("name"));--> statement-breakpoint
CREATE INDEX "threads_weave_idx" ON "threads" USING btree ("weave_id");