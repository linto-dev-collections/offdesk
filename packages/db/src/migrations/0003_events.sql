CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_key` text NOT NULL,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`discord_message_id` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`run_key`) REFERENCES `runs`(`run_key`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "events_kind_ck" CHECK("events"."kind" IN ('progress', 'done', 'blocked', 'stop_hook', 'error'))
);
--> statement-breakpoint
CREATE INDEX `events_run_id_idx` ON `events` (`run_key`,`id`);