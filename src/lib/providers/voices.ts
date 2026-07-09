/**
 * TTS 音色清单（双 provider）。
 *
 * 火山引擎(volcengine)：从 Storybound 摸到的 157 个大模型音色，去重音区后 109 个角色，
 * 取最优音区（优先 uranus 最新 > moon > mars）。按图书带货场景分组，带中文名。
 * StepFun：保留原有少量音色。
 *
 * voiceId 直接传给各自 provider 的 API。面板按 group 分组展示、可搜索。
 */

export type TtsProvider = "volcengine" | "stepfun" | "aurastd";

export interface VoiceOption {
  id: string; // provider 的音色ID
  name: string; // 中文显示名
  group: string; // 分组
  gender: "male" | "female";
}

/** 火山引擎音色（仅含当前账号已授权的 moon 音区，31 个，按场景分组） */
export const VOLC_VOICES: VoiceOption[] = [
  // —— 解说/科普（图书带货主力）——
  { id: "zh_male_jieshuoxiaoming_moon_bigtts", name: "解说小明", group: "解说科普", gender: "male" },
  { id: "zh_female_xinlingjitang_moon_bigtts", name: "心灵鸡汤", group: "解说科普", gender: "female" },
  { id: "zh_male_dongfanghaoran_moon_bigtts", name: "东方浩然", group: "解说科普", gender: "male" },

  // —— 沉稳/磁性男声 ——
  { id: "zh_male_yuanboxiaoshu_moon_bigtts", name: "渊博小叔", group: "磁性男声", gender: "male" },
  { id: "zh_male_shenyeboke_moon_bigtts", name: "深夜播客", group: "磁性男声", gender: "male" },
  { id: "zh_male_guozhoudege_moon_bigtts", name: "国粹德哥", group: "磁性男声", gender: "male" },
  { id: "zh_male_aojiaobazong_moon_bigtts", name: "傲娇霸总", group: "磁性男声", gender: "male" },

  // —— 阳光/青年男声 ——
  { id: "zh_male_yangguangqingnian_moon_bigtts", name: "阳光青年", group: "青年男声", gender: "male" },
  { id: "zh_male_wennuanahu_moon_bigtts", name: "暖男阿虎", group: "青年男声", gender: "male" },
  { id: "zh_male_shaonianzixin_moon_bigtts", name: "少年自信", group: "青年男声", gender: "male" },
  { id: "zh_male_linjiananhai_moon_bigtts", name: "邻家男孩", group: "青年男声", gender: "male" },
  { id: "zh_male_haoyuxiaoge_moon_bigtts", name: "豪语小哥", group: "青年男声", gender: "male" },
  { id: "zh_male_guangxiyuanzhou_moon_bigtts", name: "广西原州", group: "青年男声", gender: "male" },

  // —— 温柔/治愈女声 ——
  { id: "zh_female_wenrouxiaoya_moon_bigtts", name: "温柔小雅", group: "温柔女声", gender: "female" },
  { id: "zh_female_qinqienvsheng_moon_bigtts", name: "亲切女声", group: "温柔女声", gender: "female" },
  { id: "zh_female_linjianvhai_moon_bigtts", name: "邻家女孩", group: "温柔女声", gender: "female" },
  { id: "zh_female_meituojieer_moon_bigtts", name: "美拓杰儿", group: "温柔女声", gender: "female" },

  // —— 御姐/情感女声 ——
  { id: "zh_female_gaolengyujie_moon_bigtts", name: "高冷御姐", group: "御姐情感", gender: "female" },
  { id: "zh_female_meilinvyou_moon_bigtts", name: "魅力女友", group: "御姐情感", gender: "female" },
  { id: "zh_female_sajiaonvyou_moon_bigtts", name: "撒娇女友", group: "御姐情感", gender: "female" },
  { id: "zh_female_yuanqinvyou_moon_bigtts", name: "元气女友", group: "御姐情感", gender: "female" },

  // —— 甜美/萌系 ——
  { id: "zh_female_tianmeixiaoyuan_moon_bigtts", name: "甜美校园", group: "甜美萌系", gender: "female" },
  { id: "zh_female_tianmeiyueyue_moon_bigtts", name: "甜美月月", group: "甜美萌系", gender: "female" },
  { id: "zh_female_kailangjiejie_moon_bigtts", name: "开朗姐姐", group: "甜美萌系", gender: "female" },
  { id: "zh_female_qingchezizi_moon_bigtts", name: "清澈梓梓", group: "甜美萌系", gender: "female" },
  { id: "zh_female_shuangkuaisisi_moon_bigtts", name: "爽快思思", group: "甜美萌系", gender: "female" },
  { id: "zh_female_wanwanxiaohe_moon_bigtts", name: "弯弯小何", group: "甜美萌系", gender: "female" },

  // —— 特色/方言/角色 ——
  { id: "zh_male_jingqiangkanye_moon_bigtts", name: "京腔侃爷", group: "特色角色", gender: "male" },
  { id: "zh_male_beijingxiaoye_moon_bigtts", name: "北京小爷", group: "特色角色", gender: "male" },
  { id: "zh_female_daimengchuanmei_moon_bigtts", name: "呆萌川妹", group: "特色角色", gender: "female" },
  { id: "zh_male_yuzhouzixuan_moon_bigtts", name: "宇宙梓轩", group: "特色角色", gender: "male" },
];

/** StepFun 音色（原有，少量） */
export const STEPFUN_VOICES: VoiceOption[] = [
  { id: "cixingnansheng", name: "磁性男声", group: "通用", gender: "male" },
  { id: "wenrounvsheng", name: "温柔女声", group: "通用", gender: "female" },
  { id: "qinqienvsheng", name: "亲切女声", group: "通用", gender: "female" },
  { id: "yuanqinansheng", name: "元气男声", group: "通用", gender: "male" },
];

/**
 * Aura Studio (MiniMax 转发) 音色 —— 全部来自用户自定义(data/custom-voices.json),
 * 由配音面板增删,不在此硬编码。这里留空数组作为"内置"占位;实际清单在运行时合并自定义音色。
 * 见 src/lib/customVoices.ts 与 /api/voices。
 */
export const AURA_VOICES: VoiceOption[] = [];

export function voicesOf(provider: TtsProvider): VoiceOption[] {
  if (provider === "stepfun") return STEPFUN_VOICES;
  if (provider === "aurastd") return AURA_VOICES;
  return VOLC_VOICES;
}

export function defaultVoiceOf(provider: TtsProvider): string {
  return voicesOf(provider)[0]?.id ?? "";
}
