export interface LLMGenerationMetrics {
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  latencyMs: number;
  estimatedCostUsd?: number;
  promptSnippet?: string;
  status: "success" | "error" | "halted";
  distinctId?: string;
}

export interface GuardrailBlockedEvent {
  service: string;
  attemptedPrice: number;
  budgetCeiling: number;
  exceededBy: number;
  reason: string;
  distinctId?: string;
}

export interface PriceAnomalyEvent {
  service: string;
  currentPrice: number;
  baselinePrice: number;
  percentageJump: string | number;
  holdTriggered: boolean;
  distinctId?: string;
}

export interface PaymentCompletedEvent {
  orderId: string;
  service: string;
  amount: number;
  budgetCeiling: number;
  savingsEnforced: number;
  payerEmail?: string;
  paymentMethod?: string;
  distinctId?: string;
}

export interface MandateCreatedEvent {
  mandateId: string;
  service: string;
  budgetCeiling: number;
  recurrence: string;
  strictMode: boolean;
  distinctId?: string;
}

/**
 * Calculates estimated Gemini reasoning cost in USD
 * Pricing: $0.075 / 1M input tokens, $0.30 / 1M output tokens
 */
export function calculateGeminiCost(inputTokens: number, outputTokens: number): number {
  const inputCost = (inputTokens / 1_000_000) * 0.075;
  const outputCost = (outputTokens / 1_000_000) * 0.3;
  return Number((inputCost + outputCost).toFixed(7));
}
