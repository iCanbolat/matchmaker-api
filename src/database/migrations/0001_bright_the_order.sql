ALTER TABLE "users" ADD COLUMN "refresh_token_hash" varchar(255);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "refresh_token_expires_at" timestamp;