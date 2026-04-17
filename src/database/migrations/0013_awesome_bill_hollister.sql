CREATE TABLE "user_boosts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"starts_at" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_boosts" ADD CONSTRAINT "user_boosts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_user_boosts_user_created" ON "user_boosts" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_user_boosts_active_window" ON "user_boosts" USING btree ("starts_at","expires_at");