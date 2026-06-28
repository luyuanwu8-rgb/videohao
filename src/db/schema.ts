import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, real, unique } from "drizzle-orm/sqlite-core";

/**
 * tasks — 一条视频一行。挂全部产物的根。
 */
export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  status: text("status").notNull().default("pending"), // pending|queued|running|completed|failed
  sourceUrl: text("source_url"), // 抖音分享链接
  title: text("title"),
  track: text("track").notNull().default("health"), // 赛道: health|emotion|parenting|...
  // 元数据快照（标题/播放/作者/封面），由 extract 写入
  sourceMeta: text("source_meta", { mode: "json" }).$type<Record<string, unknown>>(),
  error: text("error"),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
});

/**
 * steps — 每个任务的每个 step 一行。DAG 调度器据此判断依赖与状态。
 */
export const steps = sqliteTable("steps", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  name: text("name").notNull(), // extract|transcribe|viralAnalyze|rewrite|storyboard|...
  status: text("status").notNull().default("pending"), // pending|running|completed|failed|skipped
  startedAt: integer("started_at"),
  endedAt: integer("ended_at"),
  error: text("error"),
  // 成本可见性：每步记 token/调用花费，跑完能看"这条视频成本多少"
  cost: real("cost").notNull().default(0),
  usage: text("usage", { mode: "json" }).$type<Record<string, unknown>>(),
});

/**
 * artifacts — 每个 step 的产物文件，带版本。
 * 支持 rewrite_v1 / rewrite_v2 / rewrite_v3 共存，可回溯、可对比。
 */
export const artifacts = sqliteTable("artifacts", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  stepName: text("step_name").notNull(),
  filePath: text("file_path").notNull(), // 相对 data/tasks/{id}/
  fileType: text("file_type").notNull(), // json|txt|wav|png|mp4|srt
  version: integer("version").notNull().default(1),
  // 给将来的素材复用库留的接缝：生成图的 scene/visual 标签 + prompt
  tag: text("tag"),
  meta: text("meta", { mode: "json" }).$type<Record<string, unknown>>(),
  createdAt: integer("created_at").notNull().default(sql`(unixepoch())`),
});

/**
 * ☆ assets — 素材复用库。v1 留接缝、不建实现。
 * 将来匹配 visual 描述文本的 embedding（不做图像 embedding）。
 * 暂不建表，schema 先占位说明，等攒够语料再启用。
 */

/**
 * promptsConfig — 提示词前端化。每个 step×track 一行，用户可在 Web 编辑。
 * system = 系统提示全文；buildTemplate = 带 {占位符} 的用户提示模板。
 * loadPrompt 优先读本表，回退源码默认。
 */
export const promptsConfig = sqliteTable(
  "prompts_config",
  {
    id: text("id").primaryKey(),
    step: text("step").notNull(), // viralAnalyze|rewrite|storyboard|imageGenerate
    track: text("track").notNull(), // base|health|emotion|...
    system: text("system").notNull(),
    buildTemplate: text("build_template").notNull(), // 含 {script}/{transcript}/{viral}/{visual} 占位符
    version: integer("version").notNull().default(1),
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
  },
  (t) => [unique().on(t.step, t.track)]
);

/**
 * apiConfigs — API/env 配置前端化。每个 key 一行，用户可在 Web 设置页编辑。
 * env() 启动时把本表预加载进内存缓存，同步读取；写库后刷新缓存。
 */
export const apiConfigs = sqliteTable(
  "api_configs",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(), // llm|stepfun|volcengine|gptimage|tikhub|global
    key: text("key").notNull(), // env 变量名，如 LLM_API_KEY
    value: text("value").notNull().default(""),
    description: text("description"),
    isSecret: integer("is_secret").notNull().default(1), // 1=密钥脱敏显示
    updatedAt: integer("updated_at").notNull().default(sql`(unixepoch())`),
  },
  (t) => [unique().on(t.key)]
);

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type Step = typeof steps.$inferSelect;
export type NewStep = typeof steps.$inferInsert;
export type Artifact = typeof artifacts.$inferSelect;
export type NewArtifact = typeof artifacts.$inferInsert;
export type PromptConfig = typeof promptsConfig.$inferSelect;
export type ApiConfig = typeof apiConfigs.$inferSelect;
