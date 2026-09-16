CREATE TABLE `discord_interactions` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`run_key` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`run_key`) REFERENCES `runs`(`run_key`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "discord_interactions_id_shape_ck" CHECK("discord_interactions"."id" NOT GLOB '*[^0-9]*' AND length("discord_interactions"."id") BETWEEN 15 AND 24),
	CONSTRAINT "discord_interactions_kind_ck" CHECK("discord_interactions"."kind" IN ('command', 'component'))
);
--> statement-breakpoint
CREATE INDEX `discord_interactions_created_idx` ON `discord_interactions` (`created_at`);