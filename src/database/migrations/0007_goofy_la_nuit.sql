CREATE TABLE "swipes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"swiper_id" uuid NOT NULL,
	"swiped_id" uuid NOT NULL,
	"direction" varchar(16) NOT NULL,
	"is_undone" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "swipes" ADD CONSTRAINT "swipes_swiper_id_users_id_fk" FOREIGN KEY ("swiper_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swipes" ADD CONSTRAINT "swipes_swiped_id_users_id_fk" FOREIGN KEY ("swiped_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "swipes_swiper_swiped_unique" ON "swipes" USING btree ("swiper_id","swiped_id");--> statement-breakpoint
CREATE INDEX "idx_swipes_swiper_created" ON "swipes" USING btree ("swiper_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_swipes_swiped" ON "swipes" USING btree ("swiped_id","direction");