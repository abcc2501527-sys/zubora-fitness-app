/**
 * Gemini API 呼び出し（目標ロードマップ生成）。
 * -------------------------------------------------------------
 * REST を fetch で直叩き（SDK 依存を増やさない・RN で確実に動く）。
 * 構造化出力: generationConfig.responseMimeType + responseSchema。
 * 設計: docs/goal-roadmap-design.md §6
 */

import { ROADMAP_RESPONSE_SCHEMA } from '@/lib/goal-roadmap-schema';
import type { RoadmapPrompt } from '@/lib/goal-prompt';

/**
 * 採用モデル。仕様書の決定は gemini-3.5-flash。
 * より新しい gemini-3.8-flash に上げたい場合はここだけ変更。
 * モデル一覧: https://ai.google.dev/gemini-api/docs/models
 */
export const GEMINI_MODEL = 'gemini-3.5-flash';

const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

/** 生成に許す最大待ち時間（ms）。generating 画面で吸収される想定。 */
const TIMEOUT_MS = 60_000;

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly kind: 'network' | 'http' | 'blocked' | 'empty' | 'parse',
  ) {
    super(message);
    this.name = 'GeminiError';
  }
}

/**
 * プロンプトを投げて、パース済みの JSON（未検証の unknown）を返す。
 * ネットワーク・HTTP・セーフティブロック・空応答・JSON 破損は GeminiError を throw。
 */
export async function callGeminiForRoadmap(
  prompt: RoadmapPrompt,
  apiKey: string,
): Promise<unknown> {
  const body = {
    systemInstruction: { parts: [{ text: prompt.system }] },
    contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: ROADMAP_RESPONSE_SCHEMA,
      temperature: 0.7,
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey, // キーは URL に載せない
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    throw new GeminiError(
      controller.signal.aborted ? '生成がタイムアウトしました' : `通信エラー: ${String(e)}`,
      'network',
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new GeminiError(`Gemini API エラー (${res.status}): ${detail.slice(0, 300)}`, 'http');
  }

  const json = (await res.json().catch(() => null)) as GeminiResponse | null;

  if (json?.promptFeedback?.blockReason) {
    throw new GeminiError(`入力がブロックされました: ${json.promptFeedback.blockReason}`, 'blocked');
  }

  const candidate = json?.candidates?.[0];
  if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
    throw new GeminiError(`生成が中断されました: ${candidate.finishReason}`, 'blocked');
  }

  const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  if (!text.trim()) {
    throw new GeminiError('Gemini から空の応答が返りました', 'empty');
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new GeminiError(`応答 JSON のパースに失敗: ${text.slice(0, 300)}`, 'parse');
  }
}

/* ---- Gemini REST レスポンスの最小型 ---- */
interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
}
