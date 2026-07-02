import type { StepDef } from "./types";
import { chat, parseJsonRobust } from "@/lib/providers/llm";
import { loadPrompt } from "@/lib/prompts";
import { storyboardSchema, rewriteSchema, directorSchema, castConfigSchema, type Director } from "@/lib/domain";
import { estimateDuration } from "@/lib/providers/stepfun";

/**
 * director: 顶级导演层。读改写稿(剧本) + 分镜(已切好的句级 scene),
 * 先提取世界观(国籍/年代/族裔/地域),再规划画面节拍。
 *
 * 阶段4 强化:
 * - 提取优先:从文案(名字/地名/文化线索)判定 setting,cast 与所有 composition 都据此,根治"美国人配中国背景"。
 * - 四层匹配:优先直译文案比喻 → 造贴切隐喻 → 人物/情绪/行为/后果 → 一切符合 setting;健康赛道只禁临床物件不禁话题。
 * - 密度(路线C):按文案字数估时算目标图数,长句拆多拍(sceneIds 共享句号、不同画面时刻),校验偏少则重试增密。
 *
 * 产物 director.json。
 */
export const director: StepDef = {
  name: "director",
  deps: ["assetSearch"],
  output: "director.json",
  run: async (ctx) => {
    const board = storyboardSchema.parse(await ctx.readJSON("storyboard.json"));
    const rw = rewriteSchema.parse(await ctx.readJSON("rewrite.json"));
    const sceneIds = board.scenes.map((s) => s.id);

    // 画面密度目标:按文案字数估时(不用不可靠的 estDuration),每张图约 targetSec 秒
    // targetSec 优先取配置中心写入的 render-config.imageSeconds,否则 env,否则 4.5
    const totalEst = board.scenes.reduce((sum, s) => sum + estimateDuration(s.text), 0);
    let targetSec = Number(process.env.DIRECTOR_TARGET_SEC ?? "4.5");
    try {
      const rc = await ctx.readJSON<{ imageSeconds?: number }>("render-config.json");
      if (rc?.imageSeconds && rc.imageSeconds > 0) targetSec = Number(rc.imageSeconds);
    } catch {
      /* 无 render-config 走默认 */
    }
    const targetBeats = Math.max(1, Math.round(totalEst / targetSec));

    // 读用户锁定的人物(单任务级)。locked 时导演必须用这些角色,不得自创。
    let lockedCast: { id: string; bible: string }[] | null = null;
    try {
      const cc = castConfigSchema.parse(await ctx.readJSON("cast-config.json"));
      if (cc.locked && cc.cast.length) lockedCast = cc.cast;
    } catch {
      /* 无锁定配置,导演自动选角 */
    }

    let plan: Director;
    if (ctx.mode === "mock") {
      // mock:按目标秒数分组(每组累计估时~targetSec 即开新拍),setting 留空,中性 cast
      const beats: Director["beats"] = [];
      let cur: typeof board.scenes = [];
      let curDur = 0;
      const flush = () => {
        if (!cur.length) return;
        beats.push({
          id: beats.length + 1,
          sceneIds: cur.map((s) => s.id),
          use: lockedCast ? lockedCast[0].id : "main",
          shotType: "中景",
          mood: "平和",
          composition: cur[0].visual || "生活场景",
        });
        cur = [];
        curDur = 0;
      };
      for (const s of board.scenes) {
        cur.push(s);
        curDur += estimateDuration(s.text);
        if (curDur >= targetSec) flush();
      }
      flush();
      plan = {
        setting: { region: "", era: "", ethnicity: "", locale: "", notes: "mock" },
        audience: "",
        theme: "mock",
        emotionArc: "",
        visualTone: "写实成熟质感,温暖自然光",
        cast: lockedCast ?? [{ id: "main", bible: "符合受众的人物" }],
        beats,
      };
    } else {
      const prompt = await loadPrompt("director", ctx.track);

      // 第一步:专注的"世界观提取"独立调用(单一任务→可靠,不像复杂规划里 setting 总被跳过)
      let setting = { region: "", era: "", ethnicity: "", locale: "", notes: "" };
      try {
        const { content, cost } = await chat(
          "你是文案世界观分析助手。判定这段文案主角/主要人物的国籍族裔与场景,供后续画面严格遵循。" +
            "依据:人物名字(洛朗/艾琳娜/John/Emma→西方欧美, 田中/村上/佐藤→日本, 金/朴→韩国, 张伟/李娜→中国)、地名、文化线索。" +
            "只输出 JSON:{region(国籍/地域,如 法国/美国/日本/中国), era(年代,如 现代/1980年代/古代), ethnicity(族裔外貌,如 白人/东亚人/黑人), locale(场景基调,如 法国乡村/东京都市/中国城镇)}。" +
            "无任何线索才填 region:中国, era:现代, ethnicity:东亚人, locale:中国城乡。",
          `文案:\n${rw.script}\n\n请输出世界观 JSON。`,
          ctx.mode,
          { json: true }
        );
        ctx.reportCost(cost, { provider: "llm", step: "director-setting" });
        const s = await parseJsonRobust<{ region?: string; era?: string; ethnicity?: string; locale?: string }>(content, ctx.mode);
        setting = {
          region: String(s.region ?? ""), era: String(s.era ?? ""),
          ethnicity: String(s.ethnicity ?? ""), locale: String(s.locale ?? ""), notes: "",
        };
        ctx.log(`世界观提取: ${[setting.region, setting.era, setting.ethnicity, setting.locale].filter(Boolean).join(" / ") || "默认中国"}`);
      } catch (e) {
        ctx.log(`世界观提取失败,退回中国默认: ${e instanceof Error ? e.message : e}`);
        setting = { region: "中国", era: "现代", ethnicity: "东亚人", locale: "中国城乡", notes: "提取失败默认" };
      }
      const worldview =
        `国籍/地域:${setting.region || "中国"} | 年代:${setting.era || "现代"} | 人物族裔:${setting.ethnicity || "东亚人"} | 场景基调:${setting.locale || "中国城乡"}`;

      const sceneList = board.scenes
        .map((s) => `[${s.id}] 口播:${s.text}${s.visual ? ` | 画面:${s.visual}` : ""}`)
        .join("\n");
      const lockedCastText = lockedCast
        ? lockedCast.map((c) => `${c.id}: ${c.bible}`).join("；")
        : "（无，由你按世界观自行选角）";

      let parsed: Director | null = null;
      let lastErr: unknown;
      let feedback = "";
      const minBeats = Math.max(1, Math.floor(targetBeats * 0.6));
      for (let attempt = 0; attempt < 3; attempt++) {
        const userMsg =
          prompt.build({ script: rw.script, sourceBook: rw.sourceBook, sceneList, lockedCast: lockedCastText, targetBeats, targetSec, worldview }) +
          feedback;
        const { content, cost } = await chat(prompt.system, userMsg, ctx.mode, { json: true });
        ctx.reportCost(cost, { provider: "llm", step: "director" });
        try {
          const p = directorSchema.parse(await parseJsonRobust(content, ctx.mode));
          // 密度校验:偏少则带反馈重试增密(保留本次作兜底)
          if (p.beats.length < minBeats && attempt < 2) {
            parsed = p;
            feedback = `\n\n【上次只给了 ${p.beats.length} 拍,偏少。目标约 ${targetBeats} 拍。请把长句拆成多拍(多拍 sceneIds 共享同一句号、给不同的画面时刻),让成片画面更丰富,不要多句长时间共用一张图。】`;
            ctx.log(`导演画面数偏少(${p.beats.length}/${targetBeats}),重试要求增密…`);
            continue;
          }
          parsed = p;
          break;
        } catch (e) {
          lastErr = e;
          ctx.log(`导演方案 JSON 解析失败(第${attempt + 1}次)，重试中…`);
        }
      }
      if (!parsed) return { ok: false, error: `导演方案解析失败: ${lastErr}` };
      plan = parsed;
      plan.setting = setting; // 强制用提取到的世界观(复杂规划调用里的 setting 常空,不信任)
      // 锁定人物:强制覆盖 LLM 的 cast
      if (lockedCast) plan.cast = lockedCast;

      // 话术句归并(确定性兜底):独立分类"哪些句是无画面价值的话术句"→ 强制并入相邻内容拍,
      // 不让它们单独开拍配突兀的图。prompt 软引导不可靠(LLM 常仍单独开拍),故加此硬保证。
      try {
        const ctaIds = await classifyCtaScenes(board.scenes, ctx);
        if (ctaIds.size) {
          const before = plan.beats.length;
          plan.beats = mergeCtaBeats(plan.beats, ctaIds);
          if (plan.beats.length !== before) ctx.log(`话术句归并: ${before}→${plan.beats.length} 拍(套话句并入相邻拍,不单独配图)`);
        }
      } catch (e) {
        ctx.log(`话术句分类跳过: ${e instanceof Error ? e.message : e}`);
      }
    }

    // 兜底校验:确保每个 sceneId 都被某拍覆盖(允许被多拍共享),漏的并入末拍
    const covered = new Set(plan.beats.flatMap((b) => b.sceneIds));
    const missing = sceneIds.filter((id) => !covered.has(id));
    if (missing.length && plan.beats.length) {
      plan.beats[plan.beats.length - 1].sceneIds.push(...missing);
      ctx.log(`补漏：${missing.length} 个句子并入末拍`);
    }

    await ctx.writeJSON("director.json", plan);
    const s = plan.setting;
    ctx.log(
      `导演方案: ${plan.beats.length} 拍(目标~${targetBeats}) / ${sceneIds.length} 句 · 角色 ${plan.cast.length} · ` +
        `世界观[${[s.region, s.era, s.ethnicity, s.locale].filter(Boolean).join("/") || "默认"}]`
    );
    return { ok: true };
  },
};

/** 独立分类:哪些 scene 是"无画面价值的话术句"(购买/关注引导、免责声明、泛泛收尾)。
 * 单一任务→LLM 判定可靠;基于语义功能而非关键词。返回话术句 sceneId 集合。 */
async function classifyCtaScenes(
  scenes: { id: number; text: string }[],
  ctx: { mode: "mock" | "real"; reportCost: (c: number, u?: Record<string, unknown>) => void }
): Promise<Set<number>> {
  if (ctx.mode === "mock") return new Set();
  const list = scenes.map((s) => `[${s.id}] ${s.text}`).join("\n");
  const { content, cost } = await chat(
    "你是文案分析助手。判定下列每个句子是否为'话术句'——即只做购买引导、关注/点赞/收藏互动引导、免责声明、或泛泛收尾(如'书里都有')," +
      "不描述任何能画出来的具体情节/人物/动作/场景。判定看功能不看具体用词。" +
      "只输出 JSON:{ctaIds: number[]},列出所有话术句的编号;没有则空数组。",
    `句子列表:\n${list}\n\n请输出话术句编号 JSON。`,
    "real",
    { json: true }
  );
  ctx.reportCost(cost, { provider: "llm", step: "director-cta" });
  try {
    const j = await parseJsonRobust<{ ctaIds?: number[] }>(content, "real");
    return new Set((j.ctaIds ?? []).filter((n) => Number.isInteger(n)));
  } catch {
    return new Set();
  }
}

/** 确定性归并:凡"整拍只含话术句"的拍,并入相邻内容拍(优先前一拍,首拍则并入后一拍),
 * 保证套话句绝不单独占一张图。sceneId 全保留、排序、不丢弃。含内容句的混合拍不动。 */
function mergeCtaBeats<T extends { id: number; sceneIds: number[] }>(beats: T[], ctaIds: Set<number>): T[] {
  const isCtaOnly = (b: T) => b.sceneIds.length > 0 && b.sceneIds.every((id) => ctaIds.has(id));
  const out: T[] = [];
  const pending: number[] = []; // 首部连续话术句,暂存待并入后续首个内容拍
  for (const b of beats) {
    if (isCtaOnly(b)) {
      if (out.length > 0) {
        // 并入前一个已保留的拍(沿用其画面)
        out[out.length - 1].sceneIds.push(...b.sceneIds);
      } else {
        pending.push(...b.sceneIds); // 还没有内容拍,暂存
      }
    } else {
      if (pending.length) { b.sceneIds.unshift(...pending); pending.length = 0; }
      out.push(b);
    }
  }
  // 全片都是话术句的极端情况:保留原样(至少有图),把 pending 并入末拍
  if (pending.length) {
    if (out.length) out[out.length - 1].sceneIds.push(...pending);
    else return beats;
  }
  // 每拍 sceneId 去重+排序,保持时间线连续
  for (const b of out) b.sceneIds = [...new Set(b.sceneIds)].sort((a, c) => a - c);
  return out;
}

