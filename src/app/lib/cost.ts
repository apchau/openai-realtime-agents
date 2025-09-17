export type ModelCategory = "text" | "realtime";

export interface ModelPricing {
  /** Friendly identifier for the pricing entry. */
  name: string;
  /** The usage category (text or realtime) for the model. */
  category: ModelCategory;
  /** Cost in USD per one million input tokens. */
  inputCostPerMillion: number;
  /** Cost in USD per one million output tokens. */
  outputCostPerMillion: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface CostBreakdown {
  inputCost: number;
  outputCost: number;
  totalCost: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  /**
   * GPT-4o Realtime models share the same token billing as GPT-4o (USD $5 / 1M input, $15 / 1M output).
   * Source: https://openai.com/pricing
   */
  "gpt-4o-realtime": {
    name: "GPT-4o Realtime",
    category: "realtime",
    inputCostPerMillion: 5,
    outputCostPerMillion: 15,
  },
  /**
   * GPT-4o models (text or JSON) share the same pricing as realtime, included for completeness.
   */
  "gpt-4o": {
    name: "GPT-4o",
    category: "text",
    inputCostPerMillion: 5,
    outputCostPerMillion: 15,
  },
  /**
   * GPT-4.1 text-based Responses API pricing (USD $15 / 1M input, $60 / 1M output).
   */
  "gpt-4.1": {
    name: "GPT-4.1",
    category: "text",
    inputCostPerMillion: 15,
    outputCostPerMillion: 60,
  },
  /**
   * GPT-4o mini pricing (USD $0.15 / 1M input, $0.60 / 1M output).
   */
  "gpt-4o-mini": {
    name: "GPT-4o mini",
    category: "text",
    inputCostPerMillion: 0.15,
    outputCostPerMillion: 0.6,
  },
};

function cloneTotals(): TokenUsage & CostBreakdown {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    inputCost: 0,
    outputCost: 0,
    totalCost: 0,
  };
}

export function emptyUsageTotals(): TokenUsage & CostBreakdown {
  return cloneTotals();
}

const PRICING_KEYS = Object.keys(MODEL_PRICING);

/**
 * Resolve pricing information for a given model string. Handles versioned names by matching
 * the longest pricing key that is a prefix of the provided model.
 */
export function getPricingForModel(model: string):
  | { resolvedModel: string; pricing: ModelPricing }
  | null {
  if (!model) return null;
  const exact = MODEL_PRICING[model];
  if (exact) {
    return { resolvedModel: model, pricing: exact };
  }

  const lowerModel = model.toLowerCase();
  let bestMatch: string | null = null;
  for (const key of PRICING_KEYS) {
    if (lowerModel.startsWith(key.toLowerCase())) {
      if (!bestMatch || key.length > bestMatch.length) {
        bestMatch = key;
      }
    }
  }

  if (!bestMatch) {
    return null;
  }

  return { resolvedModel: bestMatch, pricing: MODEL_PRICING[bestMatch] };
}

/**
 * Normalizes a variety of usage payload shapes into a consistent token usage object.
 */
export function normalizeUsage(rawUsage: any): TokenUsage {
  if (!rawUsage || typeof rawUsage !== "object") {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }

  const inputCandidates = [
    rawUsage.inputTokens,
    rawUsage.input_tokens,
    rawUsage.prompt_tokens,
    rawUsage.promptTokens,
    rawUsage.input,
  ];
  const outputCandidates = [
    rawUsage.outputTokens,
    rawUsage.output_tokens,
    rawUsage.completion_tokens,
    rawUsage.completionTokens,
    rawUsage.output,
  ];
  const totalCandidates = [
    rawUsage.totalTokens,
    rawUsage.total_tokens,
    rawUsage.total,
  ];

  const pickNumber = (values: any[]): number => {
    for (const value of values) {
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string") {
        const parsed = Number(value);
        if (!Number.isNaN(parsed)) return parsed;
      }
    }
    return 0;
  };

  const inputTokens = pickNumber(inputCandidates);
  const outputTokens = pickNumber(outputCandidates);
  const totalTokensCandidate = pickNumber(totalCandidates);
  const totalTokens = totalTokensCandidate || inputTokens + outputTokens;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
  };
}

export function calculateUsageCost(
  usage: TokenUsage,
  pricing: ModelPricing,
  precision: number = 6,
): CostBreakdown {
  const factor = 1_000_000;

  const round = (value: number) => {
    const multiplier = 10 ** precision;
    return Math.round(value * multiplier) / multiplier;
  };

  const inputCost = round((usage.inputTokens / factor) * pricing.inputCostPerMillion);
  const outputCost = round((usage.outputTokens / factor) * pricing.outputCostPerMillion);
  const totalCost = round(inputCost + outputCost);

  return { inputCost, outputCost, totalCost };
}

export function accumulateTotals(
  base: TokenUsage & CostBreakdown,
  delta: TokenUsage,
  costDelta?: CostBreakdown | null,
): TokenUsage & CostBreakdown {
  return {
    inputTokens: base.inputTokens + delta.inputTokens,
    outputTokens: base.outputTokens + delta.outputTokens,
    totalTokens: base.totalTokens + delta.totalTokens,
    inputCost: base.inputCost + (costDelta?.inputCost ?? 0),
    outputCost: base.outputCost + (costDelta?.outputCost ?? 0),
    totalCost: base.totalCost + (costDelta?.totalCost ?? 0),
  };
}

