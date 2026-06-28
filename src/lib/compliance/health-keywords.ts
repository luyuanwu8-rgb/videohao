/**
 * 健康养生赛道合规词库。
 *
 * 四类:
 *  - textForbidden:  文案违禁词 → 安全改写建议(rewrite/字幕检测提示用)
 *  - homophones:     高危词谐音替换(字幕规避机审,人能看懂;只替换最高危的)
 *  - visualForbidden: 画面违禁词(分镜医疗安全检测,命中即强制锁定)
 *  - metaphorMapping: 疾病 → 日常生活隐喻画面(供AI转译+一键改写参考)
 *
 * 资料来源:微信视频号运营规范 5.15-5.20 + 健康内容红线 + 违禁词汇总。
 */

/** 文案违禁词 → 安全改写建议(每词给若干替换候选) */
export const TEXT_FORBIDDEN: Record<string, string[]> = {
  治疗: ["调理", "改善", "缓解"],
  医治: ["调理", "护理"],
  根治: ["改善", "缓解", "有助于"],
  根除: ["改善", "缓解"],
  治愈: ["改善", "恢复"],
  特效: ["显著", "明显"],
  速效: ["较快", "逐渐"],
  奇效: ["明显作用"],
  神效: ["明显作用"],
  疗效: ["作用", "效果"],
  彻底解决: ["改善", "缓解"],
  彻底消除: ["逐渐改善"],
  一定有效: ["可能有助于", "建议尝试"],
  立竿见影: ["逐渐显现"],
  立刻见效: ["逐渐改善"],
  药到病除: ["有助调理"],
  起死回生: ["改善状态"],
  返老还童: ["保持活力"],
  "100%": ["大多数情况", "普遍"],
  百分之百: ["大多数情况"],
  不反弹: ["持续改善"],
  无副作用: ["温和", "天然"],
  无依赖: ["温和"],
  消炎: ["舒缓", "缓解"],
  抗炎: ["舒缓"],
  排毒: ["促进代谢", "调理"],
  解毒: ["调理"],
  活血: ["促进循环"],
  补血: ["营养补充"],
  安神: ["放松", "助眠"],
  补肾: ["滋补"],
  防癌: ["健康养护"],
  抗癌: ["健康养护"],
  降血压: ["有助血压平稳"],
  降血糖: ["有助血糖平稳"],
  降三高: ["健康调理"],
  药方: ["方子", "配方"],
  偏方: ["小方法"],
  秘方: ["方法"],
  祖传秘方: ["传统方法"],
};

/**
 * 高危词谐音替换(只替换最高危的,字幕规避机审,人能看懂)。
 * 用户确认:只替换高危词 + 替换后仍可人工二次修改。
 * 替换为拼音首字母,保留可读性(养生→Y生 而非全拼)。
 */
export const HOMOPHONES: Record<string, string> = {
  治疗: "ZL",
  治愈: "ZY",
  根治: "GZ",
  化疗: "HL",
  放疗: "FL",
  手术: "SS",
  注射: "ZS",
  输液: "SY",
  药物: "YW",
  药品: "YP",
  中药: "ZhY",
  西药: "XiY",
  消炎: "XY",
  抗炎: "KY",
  排毒: "PD",
  解毒: "JD",
  活血: "HX",
  补血: "BX",
  补肾: "BS",
  补药: "BY",
  疗效: "LX",
  血管: "x管",
  细胞: "XB",
  病毒: "BD",
  肿瘤: "ZL瘤",
  癌症: "A症",
  养生: "Y生",
};

/**
 * 画面违禁词(分镜 visual 医疗安全检测,命中即强制锁定生图)。
 * 任何医疗/病理/器械/痛苦画面都禁止,必须转译为日常生活隐喻。
 */
export const VISUAL_FORBIDDEN: string[] = [
  // 医疗场所
  "医院", "病房", "病床", "ICU", "重症", "手术室", "手术台", "诊室", "门诊",
  "急诊", "急救", "救护车", "化验室", "病区", "输液室",
  // 医疗器械
  "监护仪", "心电图", "输液", "吊瓶", "点滴", "注射", "针头", "针管", "采血",
  "药品", "药瓶", "药盒", "胶囊", "药片", "输液袋", "氧气管", "呼吸机",
  "CT", "X光", "核磁", "B超", "胃镜", "肠镜", "透析", "支架",
  // 病理/人体内部
  "内脏", "器官", "肝脏", "肾脏", "肺部", "胃部", "肠道特写", "血管", "动脉",
  "静脉", "血液", "血栓", "细胞", "癌细胞", "病毒", "细菌", "显微镜",
  "伤口", "溃疡", "脓", "肿瘤", "肿块", "病变", "病灶", "病理", "结石",
  "斑块", "皮损", "皮疹", "红肿",
  // 痛苦/病容
  "病容", "虚弱", "卧床不起", "痛苦表情", "憔悴", "脸色苍白", "呻吟", "捂胸",
  "捂肚", "瘫痪", "昏迷", "抽搐",
  // 医护人员(医疗场景)
  "穿白大褂", "医生诊断", "护士", "医护",
];

/**
 * 疾病 → 日常生活隐喻画面映射(供 AI 转译 + 分镜一键改写参考)。
 * key 用 | 分隔同类疾病关键词。
 */
export const METAPHOR_MAPPING: { keys: string[]; metaphor: string }[] = [
  { keys: ["糖尿病", "血糖", "胰岛素"], metaphor: "厨房里准备健康食材(蔬菜全麦)/营养搭配的餐桌/老人在公园散步" },
  { keys: ["癌症", "肿瘤", "化疗", "晚期"], metaphor: "家人陪伴的温馨客厅/翻阅书籍/窗外温暖阳光/家庭合影" },
  { keys: ["心脏病", "高血压", "心梗", "心血管", "冠心病"], metaphor: "公园慢跑/瑜伽垫拉伸/规律作息的钟表/清晨阳光" },
  { keys: ["失眠", "焦虑", "抑郁", "睡眠"], metaphor: "卧室温馨灯光/床头热牛奶/翻开的书本/安静的猫咪/舒适枕头" },
  { keys: ["肝", "肾", "排毒", "毒素"], metaphor: "绿色蔬菜特写/流动的清水/森林溪流/晨练的人" },
  { keys: ["关节", "腰", "颈椎", "疼痛", "风湿"], metaphor: "老人悠闲散步/伸展运动/温泉(非医疗)/家用按摩椅/暖阳" },
  { keys: ["肠胃", "消化", "便秘", "胃"], metaphor: "清淡粥品/温热的食物/餐桌上的养胃食材" },
  { keys: ["三高", "肥胖", "减肥"], metaphor: "健康轻食沙拉/运动鞋与瑜伽垫/体重秤旁的水果" },
];

/** 在文本里找命中的画面违禁词(返回命中词数组) */
export function findVisualForbidden(text: string): string[] {
  if (!text) return [];
  return VISUAL_FORBIDDEN.filter((w) => text.includes(w));
}

/** 在文本里找命中的文案违禁词(返回 词→建议 映射) */
export function findTextForbidden(text: string): Record<string, string[]> {
  const hits: Record<string, string[]> = {};
  if (!text) return hits;
  for (const [word, alts] of Object.entries(TEXT_FORBIDDEN)) {
    if (text.includes(word)) hits[word] = alts;
  }
  return hits;
}

/** 对文本做高危词谐音替换(只替换 HOMOPHONES 里的高危词) */
export function applyHomophones(text: string): string {
  if (!text) return text;
  let out = text;
  // 按词长降序替换,避免短词先替造成嵌套错误
  const words = Object.keys(HOMOPHONES).sort((a, b) => b.length - a.length);
  for (const w of words) {
    if (out.includes(w)) out = out.split(w).join(HOMOPHONES[w]);
  }
  return out;
}

/** 给一句含疾病的描述,返回建议的隐喻画面(找不到返回 null) */
export function suggestMetaphor(text: string): string | null {
  if (!text) return null;
  for (const { keys, metaphor } of METAPHOR_MAPPING) {
    if (keys.some((k) => text.includes(k))) return metaphor;
  }
  return null;
}


