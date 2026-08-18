ALTER TABLE "cards" ALTER COLUMN "stability" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "cards" ALTER COLUMN "difficulty" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "reviews" ALTER COLUMN "stability_before" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "reviews" ALTER COLUMN "difficulty_before" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "reviews" ALTER COLUMN "stability_after" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "reviews" ALTER COLUMN "difficulty_after" SET DATA TYPE double precision;