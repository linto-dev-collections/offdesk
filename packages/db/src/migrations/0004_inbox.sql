CREATE TABLE `inbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_key` text NOT NULL,
	`author_discord_user_id` text NOT NULL,
	`message_id` text,
	`body` text NOT NULL,
	`taken_at` integer,
	`taken_by_run_key` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`run_key`) REFERENCES `runs`(`run_key`) ON UPDATE restrict ON DELETE restrict,
	FOREIGN KEY (`taken_by_run_key`) REFERENCES `runs`(`run_key`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "inbox_body_ck" CHECK(length("inbox"."body") > 0),
	CONSTRAINT "inbox_taken_pair_ck" CHECK(("inbox"."taken_at" IS NULL) = ("inbox"."taken_by_run_key" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `inbox_pending_idx` ON `inbox` (`run_key`,`id`) WHERE "inbox"."taken_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `inbox_message_uidx` ON `inbox` (`message_id`);--> statement-breakpoint
CREATE INDEX `inbox_taken_by_idx` ON `inbox` (`taken_by_run_key`) WHERE "inbox"."taken_by_run_key" IS NOT NULL;