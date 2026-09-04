CREATE TABLE `asks` (
	`ask_id` text PRIMARY KEY NOT NULL,
	`run_key` text NOT NULL,
	`question` text NOT NULL,
	`options` text DEFAULT '[]' NOT NULL,
	`allow_free_text` integer DEFAULT 1 NOT NULL,
	`message_id` text,
	`answer` text,
	`answered_by_discord_user_id` text,
	`answered_at` integer,
	`answer_message_id` text,
	`delivered_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`run_key`) REFERENCES `runs`(`run_key`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "asks_id_shape_ck" CHECK("asks"."ask_id" GLOB 'ask_*'
       AND substr("asks"."ask_id", 5) NOT GLOB '*[^0-9a-f]*'
       AND length("asks"."ask_id") = 20),
	CONSTRAINT "asks_question_ck" CHECK(length("asks"."question") > 0),
	CONSTRAINT "asks_options_ck" CHECK(json_valid("asks"."options") AND json_type("asks"."options") = 'array'),
	CONSTRAINT "asks_allow_free_text_ck" CHECK("asks"."allow_free_text" IN (0, 1)),
	CONSTRAINT "asks_answer_pair_ck" CHECK(("asks"."answer" IS NULL) = ("asks"."answered_at" IS NULL)),
	CONSTRAINT "asks_answered_by_ck" CHECK("asks"."answered_by_discord_user_id" IS NULL OR "asks"."answer" IS NOT NULL),
	CONSTRAINT "asks_answer_message_ck" CHECK("asks"."answer_message_id" IS NULL OR "asks"."answer" IS NOT NULL),
	CONSTRAINT "asks_delivered_ck" CHECK("asks"."delivered_at" IS NULL OR "asks"."answered_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `asks_run_created_idx` ON `asks` (`run_key`,`created_at`);--> statement-breakpoint
CREATE INDEX `asks_undelivered_idx` ON `asks` (`run_key`,`created_at`) WHERE "asks"."delivered_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `asks_message_uidx` ON `asks` (`message_id`);