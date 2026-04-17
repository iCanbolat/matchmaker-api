CREATE TABLE "profile_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"viewer_id" uuid NOT NULL,
	"viewed_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "swipes" ADD COLUMN "undone_at" timestamp;--> statement-breakpoint
ALTER TABLE "profile_views" ADD CONSTRAINT "profile_views_viewer_id_users_id_fk" FOREIGN KEY ("viewer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_views" ADD CONSTRAINT "profile_views_viewed_id_users_id_fk" FOREIGN KEY ("viewed_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_profile_views_viewed" ON "profile_views" USING btree ("viewed_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_profile_views_viewer" ON "profile_views" USING btree ("viewer_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_swipes_swiper_undone" ON "swipes" USING btree ("swiper_id","undone_at");