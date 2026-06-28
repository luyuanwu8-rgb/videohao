import type { StepDef, StepName } from "./types";
import { extract } from "./extract";
import { transcribe } from "./transcribe";
import { viralAnalyze } from "./viralAnalyze";
import { rewrite } from "./rewrite";
import { storyboard } from "./storyboard";
import { assetSearch } from "./assetSearch";
import { director } from "./director";
import { imageGenerate } from "./imageGenerate";
import { tts } from "./tts";
import { subtitleAlign } from "./subtitleAlign";
import { timelineBuild } from "./timelineBuild";
import { render } from "./render";

export const STEP_REGISTRY: Record<StepName, StepDef> = {
  extract,
  transcribe,
  viralAnalyze,
  rewrite,
  storyboard,
  assetSearch,
  director,
  imageGenerate,
  tts,
  subtitleAlign,
  timelineBuild,
  render,
};

export type { StepDef, StepName } from "./types";
