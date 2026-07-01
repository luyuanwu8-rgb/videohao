import type { StepDef } from "./types";
import { chat, extractJson } from "@/lib/providers/llm";
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
    const totalEst = board.scenes.reduce((sum, s) => sum + estimateDuration(s.text), 0);
    const targetSec = Number(process.env.DIRECTOR_TARGET_SEC ?? "4.5");
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
          prompt.build({ script: rw.script, sourceBook: rw.sourceBook, sceneList, lockedCast: lockedCastText, targetBeats, targetSec }) +
          feedback;
        const { content, cost } = await chat(prompt.system, userMsg, ctx.mode, { json: true });
        ctx.reportCost(cost, { provider: "llm", step: "director" });
        try {
          const p = directorSchema.parse(JSON.parse(extractJson(content)));
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
      // 锁定人物:强制覆盖 LLM 的 cast(setting 仍用 LLM 提取的)
      if (lockedCast) plan.cast = lockedCast;
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
