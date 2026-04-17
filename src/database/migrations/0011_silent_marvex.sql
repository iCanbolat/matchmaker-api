CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"tier" varchar(32) NOT NULL,
	"platform" varchar(16) NOT NULL,
	"store_transaction_id" varchar(255),
	"starts_at" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL,
	"is_cancelled" boolean DEFAULT false NOT NULL,
	"cancelled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_store_tx_unique" ON "subscriptions" USING btree ("store_transaction_id");--> statement-breakpoint
CREATE INDEX "idx_subscriptions_user_expires" ON "subscriptions" USING btree ("user_id","expires_at");