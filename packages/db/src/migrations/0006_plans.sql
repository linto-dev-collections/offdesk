CREATE TABLE `plans` (
	`plan_id` text PRIMARY KEY NOT NULL,
	`scope_kind` text NOT NULL,
	`scope_id` text NOT NULL,
	`slug` text NOT NULL,
	`last_published_run_key` text NOT NULL,
	`file_count` integer DEFAULT 0 NOT NULL,
	`total_bytes` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`last_published_run_key`) REFERENCES `runs`(`run_key`) ON UPDATE restrict ON DELETE restrict,
	CONSTRAINT "plans_id_shape_ck" CHECK("plans"."plan_id" NOT GLOB '*[^0-9a-f]*' AND length("plans"."plan_id") = 32),
	CONSTRAINT "plans_scope_kind_ck" CHECK("plans"."scope_kind" IN ('thread', 'run')),
	CONSTRAINT "plans_scope_id_ck" CHECK(length("plans"."scope_id") > 0),
	CONSTRAINT "plans_slug_shape_ck" CHECK("plans"."slug" GLOB '[a-z0-9]*'
       AND "plans"."slug" NOT GLOB '*[^a-z0-9_-]*'
       AND length("plans"."slug") <= 64),
	CONSTRAINT "plans_counts_ck" CHECK("plans"."file_count" >= 0 AND "plans"."total_bytes" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plans_scope_slug_uidx` ON `plans` (`scope_kind`,`scope_id`,`slug`);--> statement-breakpoint
CREATE INDEX `plans_updated_idx` ON `plans` (`updated_at`);