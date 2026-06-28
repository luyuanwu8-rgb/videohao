CREATE TABLE `api_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`key` text NOT NULL,
	`value` text DEFAULT '' NOT NULL,
	`description` text,
	`is_secret` integer DEFAULT 1 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_configs_key_unique` ON `api_configs` (`key`);--> statement-breakpoint
CREATE TABLE `prompts_config` (
	`id` text PRIMARY KEY NOT NULL,
	`step` text NOT NULL,
	`track` text NOT NULL,
	`system` text NOT NULL,
	`build_template` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prompts_config_step_track_unique` ON `prompts_config` (`step`,`track`);