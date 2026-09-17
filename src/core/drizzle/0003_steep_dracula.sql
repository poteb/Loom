CREATE TABLE "request_offers" (
	"request_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"model" text,
	"effort" text,
	"note" text,
	"accepted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "request_offers_request_id_participant_id_pk" PRIMARY KEY("request_id","participant_id")
);
--> statement-breakpoint
CREATE TABLE "requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"requester_id" uuid NOT NULL,
	"owner" text DEFAULT '' NOT NULL,
	"requester_target_participant_id" uuid,
	"requester_target_keeper_id" uuid,
	"requirements" jsonb NOT NULL,
	"wanted" integer NOT NULL,
	"target_weave_id" uuid NOT NULL,
	"target_thread_id" uuid NOT NULL,
	"url" text,
	"status" text DEFAULT 'open' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"last_event_seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requests_thread_id_unique" UNIQUE("thread_id")
);
--> statement-breakpoint
CREATE TABLE "weave_invitations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"target_weave_id" uuid NOT NULL,
	"target_thread_id" uuid NOT NULL,
	"invitee_participant_id" uuid NOT NULL,
	"invitee_agent_id" uuid,
	"request_id" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"redeemed_at" timestamp with time zone,
	"redeemed_participant_id" uuid
);
--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN "capabilities" jsonb;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "lobby_weave_id" uuid;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "lobby_title" text DEFAULT 'Lobby' NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "request_id" uuid;--> statement-breakpoint
ALTER TABLE "request_offers" ADD CONSTRAINT "request_offers_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_offers" ADD CONSTRAINT "request_offers_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_requester_id_participants_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_requester_target_participant_id_participants_id_fk" FOREIGN KEY ("requester_target_participant_id") REFERENCES "public"."participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_target_weave_id_weaves_id_fk" FOREIGN KEY ("target_weave_id") REFERENCES "public"."weaves"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_target_thread_id_threads_id_fk" FOREIGN KEY ("target_thread_id") REFERENCES "public"."threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weave_invitations" ADD CONSTRAINT "weave_invitations_target_weave_id_weaves_id_fk" FOREIGN KEY ("target_weave_id") REFERENCES "public"."weaves"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weave_invitations" ADD CONSTRAINT "weave_invitations_target_thread_id_threads_id_fk" FOREIGN KEY ("target_thread_id") REFERENCES "public"."threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weave_invitations" ADD CONSTRAINT "weave_invitations_invitee_participant_id_participants_id_fk" FOREIGN KEY ("invitee_participant_id") REFERENCES "public"."participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weave_invitations" ADD CONSTRAINT "weave_invitations_invitee_agent_id_agents_id_fk" FOREIGN KEY ("invitee_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weave_invitations" ADD CONSTRAINT "weave_invitations_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "requests_requester_status_idx" ON "requests" USING btree ("requester_id","status");--> statement-breakpoint
CREATE INDEX "requests_status_expires_idx" ON "requests" USING btree ("status","expires_at");