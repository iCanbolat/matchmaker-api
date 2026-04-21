ALTER TABLE "users" ADD COLUMN "phone_number" varchar(20);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_phone_number_unique" UNIQUE("phone_number");