CREATE TABLE "user_referral_credits" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"swipe_credits" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "referrals" ADD COLUMN "bonus_type" varchar(32) DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "referrals" ADD COLUMN "bonus_value" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_referral_credits" ADD CONSTRAINT "user_referral_credits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;