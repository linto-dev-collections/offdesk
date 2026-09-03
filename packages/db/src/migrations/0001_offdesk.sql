CREATE TABLE `project_fire_credentials` (
	`project_id` text PRIMARY KEY NOT NULL,
	`ciphertext` blob NOT NULL,
	`iv` blob NOT NULL,
	`key_version` integer DEFAULT 1 NOT NULL,
	`last4` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "pfc_iv_len_ck" CHECK(length("project_fire_credentials"."iv") = 12),
	CONSTRAINT "pfc_ciphertext_ck" CHECK(length("project_fire_credentials"."ciphertext") > 0),
	CONSTRAINT "pfc_key_version_ck" CHECK("project_fire_credentials"."key_version" >= 1),
	CONSTRAINT "pfc_last4_ck" CHECK(length("project_fire_credentials"."last4") = 4)
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`discord_channel_id` text NOT NULL,
	`repo_url` text NOT NULL,
	`fire_url` text NOT NULL,
	`context_window_tokens` integer DEFAULT 200000 NOT NULL,
	`disabled_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	CONSTRAINT "projects_name_shape_ck" CHECK("projects"."name" GLOB '[a-z0-9]*'
       AND "projects"."name" NOT GLOB '*[^a-z0-9_-]*'
       AND length("projects"."name") <= 32),
	CONSTRAINT "projects_channel_shape_ck" CHECK("projects"."discord_channel_id" NOT GLOB '*[^0-9]*'
       AND length("projects"."discord_channel_id") BETWEEN 15 AND 24),
	CONSTRAINT "projects_repo_url_ck" CHECK("projects"."repo_url" LIKE 'https://%'),
	CONSTRAINT "projects_fire_url_ck" CHECK("projects"."fire_url" LIKE 'https://api.anthropic.com/%'),
	CONSTRAINT "projects_ctx_window_ck" CHECK("projects"."context_window_tokens" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_name_uidx` ON `projects` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_channel_uidx` ON `projects` (`discord_channel_id`);--> statement-breakpoint
CREATE TABLE `runs` (
	`run_key` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`prompt` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`requester_discord_user_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`thread_id` text,
	`cc_session_id` text,
	`cc_session_url` text,
	`held_at` integer,
	`activity_at` integer,
	`ctx_used_tokens` integer,
	`ctx_output_tokens` integer,
	`ctx_at` integer,
	`finished_at` integer,
	`failure_reason` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "runs_key_shape_ck" CHECK("runs"."run_key" GLOB 'OFFDESK-*'
       AND substr("runs"."run_key", 9) NOT GLOB '*[^0-9a-f]*'
       AND length("runs"."run_key") = 24),
	CONSTRAINT "runs_status_ck" CHECK("runs"."status" IN ('queued', 'running', 'waiting', 'done', 'failed', 'abandoned')),
	CONSTRAINT "runs_prompt_ck" CHECK(length("runs"."prompt") > 0),
	CONSTRAINT "runs_thread_id_ck" CHECK("runs"."thread_id" IS NULL OR length("runs"."thread_id") > 0),
	CONSTRAINT "runs_cc_pair_ck" CHECK(("runs"."cc_session_id" IS NULL) = ("runs"."cc_session_url" IS NULL)),
	CONSTRAINT "runs_ctx_pair_ck" CHECK(("runs"."ctx_at" IS NULL) = ("runs"."ctx_used_tokens" IS NULL)),
	CONSTRAINT "runs_ctx_sign_ck" CHECK(("runs"."ctx_used_tokens" IS NULL OR "runs"."ctx_used_tokens" >= 0)
       AND ("runs"."ctx_output_tokens" IS NULL OR "runs"."ctx_output_tokens" >= 0)),
	CONSTRAINT "runs_finished_ck" CHECK(("runs"."status" IN ('done', 'failed', 'abandoned')) = ("runs"."finished_at" IS NOT NULL)),
	CONSTRAINT "runs_failure_reason_ck" CHECK("runs"."failure_reason" IS NULL OR "runs"."status" IN ('failed', 'abandoned'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runs_live_thread_uidx` ON `runs` (`thread_id`) WHERE "runs"."thread_id" IS NOT NULL AND "runs"."status" IN ('queued', 'running', 'waiting');--> statement-breakpoint
CREATE INDEX `runs_status_created_idx` ON `runs` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `runs_thread_created_idx` ON `runs` (`thread_id`,`created_at`) WHERE "runs"."thread_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `runs_project_created_idx` ON `runs` (`project_id`,`created_at`);