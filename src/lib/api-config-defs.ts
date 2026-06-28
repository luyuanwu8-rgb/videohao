/**
 * API 配置项出厂清单 —— 定义有哪些 env key、归属哪个 provider、是否密钥。
 *
 * 用于:① 种子(把当前 process.env 值灌入 api_configs 表) ② 设置页按 provider 分组展示。
 * value 不在这里写死,种子时从 process.env 读当前值。
 */

export interface ApiConfigDef {
  provider: string;
  key: string; // env 变量名
  description: string;
  isSecret: boolean;
}

export const API_CONFIG_DEFS: ApiConfigDef[] = [
  // LLM(改写/分析/分镜)
  { provider: "llm", key: "LLM_BASE_URL", description: "LLM 接口域名(OpenAI 兼容)", isSecret: false },
  { provider: "llm", key: "LLM_API_KEY", description: "LLM API 密钥", isSecret: true },
  { provider: "llm", key: "LLM_MODEL", description: "LLM 模型名(如 deepseek-chat)", isSecret: false },
  { provider: "llm", key: "LLM_PRICE_IN_PER_1K", description: "输入 token 单价/1K(可空)", isSecret: false },
  { provider: "llm", key: "LLM_PRICE_OUT_PER_1K", description: "输出 token 单价/1K(可空)", isSecret: false },

  // StepFun(ASR + TTS)
  { provider: "stepfun", key: "STEP_API_KEY", description: "StepFun 密钥(优先)", isSecret: true },
  { provider: "stepfun", key: "STEPFUN_API_KEY", description: "StepFun 密钥(备用)", isSecret: true },
  { provider: "stepfun", key: "STEPFUN_ASR_BASE_URL", description: "ASR 接口域名", isSecret: false },
  { provider: "stepfun", key: "STEPFUN_ASR_MODEL", description: "ASR 模型(默认 stepaudio-2.5-asr)", isSecret: false },
  { provider: "stepfun", key: "STEPFUN_ASR_LANG", description: "ASR 语言(默认 zh)", isSecret: false },
  { provider: "stepfun", key: "STEPFUN_TTS_BASE_URL", description: "TTS 接口域名", isSecret: false },
  { provider: "stepfun", key: "STEPFUN_TTS_MODEL", description: "TTS 模型(默认 step-tts-mini)", isSecret: false },
  { provider: "stepfun", key: "STEPFUN_TTS_VOICE", description: "StepFun 默认音色", isSecret: false },
  { provider: "stepfun", key: "STEP_MIN_INTERVAL_MS", description: "请求最小间隔ms(限流,默认6500)", isSecret: false },

  // 火山引擎(TTS)
  { provider: "volcengine", key: "VOLC_TTS_APPID", description: "火山引擎 AppID", isSecret: true },
  { provider: "volcengine", key: "VOLC_TTS_TOKEN", description: "火山引擎 Token", isSecret: true },
  { provider: "volcengine", key: "VOLC_TTS_CLUSTER", description: "火山集群(默认 volcano_tts)", isSecret: false },
  { provider: "volcengine", key: "VOLC_TTS_VOICE", description: "火山默认音色", isSecret: false },

  // gpt-image(生图)
  { provider: "gptimage", key: "GPTIMAGE_BASE_URL", description: "生图接口域名", isSecret: false },
  { provider: "gptimage", key: "GPTIMAGE_API_KEY", description: "生图 API 密钥", isSecret: true },
  { provider: "gptimage", key: "GPTIMAGE_MODEL", description: "生图模型(默认 gpt-image-1)", isSecret: false },
  { provider: "gptimage", key: "GPTIMAGE_TIMEOUT_MS", description: "生图超时ms(默认180000)", isSecret: false },
  { provider: "gptimage", key: "GPTIMAGE_MAX_RETRY", description: "生图重试次数(默认2)", isSecret: false },
  { provider: "gptimage", key: "GPTIMAGE_PRICE_PER_IMAGE", description: "单图成本(可空)", isSecret: false },

  // TikHub(抖音解析)
  { provider: "tikhub", key: "TIKHUB_BASE_URL", description: "TikHub 接口域名", isSecret: false },
  { provider: "tikhub", key: "TIKHUB_API_KEY", description: "TikHub API 密钥", isSecret: true },

  // 全局
  { provider: "global", key: "PIPELINE_MODE", description: "执行模式 mock/real", isSecret: false },
  { provider: "global", key: "DEFAULT_TRACK", description: "默认赛道(如 health)", isSecret: false },
  { provider: "global", key: "IMAGE_RATIO", description: "生图比例(默认 9:16)", isSecret: false },
];
