ALTER TABLE "agents" ADD COLUMN "owner" text;--> statement-breakpoint
ALTER TABLE "participants" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "request_offers" ADD COLUMN "due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "request_offers" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "request_offers" ADD COLUMN "completion_note" text;--> statement-breakpoint
ALTER TABLE "request_offers" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "request_offers" ADD COLUMN "overdue_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "weave_invitations" ADD COLUMN "revoked_at" timestamp with time zone;