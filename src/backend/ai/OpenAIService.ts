import OpenAI from 'openai';
import type { Signal } from '../Agents';

export type AiTradeDecision = 'BUY' | 'SELL' | 'HOLD';

export interface AiSecondOpinion {
  decision: AiTradeDecision;
  confidence: number;
  reasoning: string;
}

export interface SecondOpinionInput {
  symbol: string;
  lastPrice: number;
  finalScore: number;
  signals: { trend: Signal; momentum: Signal; pullback: Signal };
  proposedAction: 'BUY' | 'SELL';
  enrichment?: {
    recentTrades: { symbol: string; side: string; pnl: number; outcome: string }[];
    atr: number | null;
    atrPercentOfPrice: number;
    trendStrengthPercent: number;
  };
}

const SYSTEM_PROMPT = `You are a conservative trading risk assistant. You receive numeric agent scores, recent closed-trade outcomes, ATR-based volatility (as fraction of price), trend strength (EMA20 vs EMA50 separation as percent of price), and a proposed direction (BUY = long, SELL = short). You do NOT execute trades. Output ONLY valid JSON with keys: decision (string: BUY, SELL, or HOLD), confidence (number 0-1), reasoning (short string). Use recent losses to be more cautious. Agree with the proposal only when indicators support it; use HOLD when uncertain or conflicting. Never predict specific future prices.`;

function parseOpinion(raw: string): AiSecondOpinion | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  const decision = o.decision;
  const confidence = o.confidence;
  const reasoning = o.reasoning;
  if (decision !== 'BUY' && decision !== 'SELL' && decision !== 'HOLD') return null;
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) return null;
  if (typeof reasoning !== 'string') return null;
  return { decision, confidence, reasoning };
}

export class OpenAIService {
  static async getSecondOpinion(input: SecondOpinionInput): Promise<AiSecondOpinion | null> {
    const key = process.env.OPENAI_API_KEY?.trim();
    if (!key) return null;

    const client = new OpenAI({ apiKey: key });
    const model = process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini';

    const userPayload = {
      symbol: input.symbol,
      lastPrice: input.lastPrice,
      finalScore: input.finalScore,
      proposedAction: input.proposedAction,
      agents: {
        trend: { score: input.signals.trend.score, reason: input.signals.trend.reason },
        momentum: { score: input.signals.momentum.score, reason: input.signals.momentum.reason },
        pullback: { score: input.signals.pullback.score, reason: input.signals.pullback.reason },
      },
      recentClosedTrades: input.enrichment?.recentTrades ?? [],
      volatility: {
        atr: input.enrichment?.atr ?? null,
        atrAsPercentOfPrice: input.enrichment?.atrPercentOfPrice ?? null,
        trendStrengthPercentOfPrice: input.enrichment?.trendStrengthPercent ?? null,
      },
    };

    try {
      const completion = await client.chat.completions.create({
        model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Assess this setup and respond with JSON only.\n${JSON.stringify(userPayload)}`,
          },
        ],
        temperature: 0.2,
        max_tokens: 450,
      });

      const text = completion.choices[0]?.message?.content?.trim();
      if (!text) return null;
      return parseOpinion(text);
    } catch (e) {
      console.error('[OpenAIService] request failed:', e);
      return null;
    }
  }
}
