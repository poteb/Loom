CREATE TABLE "read_positions" (
	"participant_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "read_positions_participant_id_thread_id_pk" PRIMARY KEY("participant_id","thread_id")
);
--> statement-breakpoint
ALTER TABLE "read_positions" ADD CONSTRAINT "read_positions_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "read_positions" ADD CONSTRAINT "read_positions_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE no action ON UPDATE no action;