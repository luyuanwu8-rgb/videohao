export type ScriptCoverageReport = {
  sourceChars: number;
  producedChars: number;
  ratio: number;
  chunkHitRatio: number;
  tailMatched: boolean;
  ok: boolean;
  reason: string;
};

export function normalizeCoverageText(text: string): string {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/[，。！？；：、,.!?;:\""'《》【】（）()「」『』—–-…·]/g, "");
}

function sampleChunks(source: string, chunkSize: number, maxChunks: number): string[] {
  if (source.length <= chunkSize) return source ? [source] : [];
  const chunks: string[] = [];
  const slots = Math.min(maxChunks, Math.ceil(source.length / chunkSize));
  for (let i = 0; i < slots; i++) {
    const pos =
      slots === 1
        ? 0
        : Math.round((i * Math.max(0, source.length - chunkSize)) / (slots - 1));
    const chunk = source.slice(pos, pos + chunkSize);
    if (chunk && !chunks.includes(chunk)) chunks.push(chunk);
  }
  return chunks;
}

export function validateScriptCoverage(
  sourceText: string,
  producedText: string,
  opts: {
    minRatio?: number;
    minChunkHitRatio?: number;
    tailChars?: number;
    chunkSize?: number;
    maxChunks?: number;
  } = {}
): ScriptCoverageReport {
  const source = normalizeCoverageText(sourceText);
  const produced = normalizeCoverageText(producedText);
  const minRatio = opts.minRatio ?? 0.95;
  const minChunkHitRatio = opts.minChunkHitRatio ?? 0.85;
  const tailChars = opts.tailChars ?? 80;
  const chunkSize = opts.chunkSize ?? 32;
  const maxChunks = opts.maxChunks ?? 24;

  if (!source) {
    return {
      sourceChars: 0,
      producedChars: produced.length,
      ratio: 1,
      chunkHitRatio: 1,
      tailMatched: true,
      ok: true,
      reason: "empty source",
    };
  }

  const ratio = produced.length / source.length;
  const tail = source.slice(-Math.min(tailChars, source.length));
  const tailMatched = produced.includes(tail);
  const chunks = sampleChunks(source, chunkSize, maxChunks);
  const chunkHits = chunks.filter((chunk) => produced.includes(chunk)).length;
  const chunkHitRatio = chunks.length ? chunkHits / chunks.length : 1;
  const ok = ratio >= minRatio && tailMatched && chunkHitRatio >= minChunkHitRatio;

  return {
    sourceChars: source.length,
    producedChars: produced.length,
    ratio,
    chunkHitRatio,
    tailMatched,
    ok,
    reason: ok
      ? "ok"
      : `script coverage failed: produced=${produced.length}/${source.length} (${(
          ratio * 100
        ).toFixed(1)}%), chunks=${chunkHits}/${chunks.length}, tail=${tailMatched ? "hit" : "miss"}`,
  };
}
