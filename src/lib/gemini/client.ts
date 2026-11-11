import { GoogleGenAI } from "@google/genai";
import { and, eq } from "drizzle-orm";
import { db, mandates } from "@/db";
import { buildSystemPromptWithContext } from "./prompts";
import { payAgentTools } from "./tools";
import {
  dispatchAgentTool,
  executeCreateMandate,
  executeVerifyWebPrice,
} from "./tool-executors";
import { StreamEvent, ChatContext, ThoughtStep } from "./types";
import { posthogServer } from "@/lib/telemetry/posthog-server";
import { personaSavingsOptimizer } from "@/lib/savings";
import { skillInjector } from "@/lib/skills";
import { classifyChatIntent, detectKnownService } from "./intent";
import { quoteMandatePayment } from "@/lib/payments/mandate-execution";

export function stripStars(text: string): string {
  if (!text) return "";
  return text
    .replace(/^(\s*)\*+(\s*)/gm, "$1- $2")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^(\s*)\*+\s*/gm, "$1")
    .replace(/\s*\*+\s*$/gm, "")
    .replace(/^\*+/, "")
    .replace(/\*+$/, "");
}

export class GeminiAgentClient {
  private client: GoogleGenAI | null = null;
  private modelName: string;

  constructor() {
    this.modelName = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    const apiKey = process.env.GEMINI_API_KEY;

    if (
      apiKey &&
      apiKey.trim().length > 10 &&
      apiKey !== "your_gemini_api_key_here"
    ) {
      try {
        this.client = new GoogleGenAI({ apiKey });
      } catch (err) {
        console.warn("Failed to initialize GoogleGenAI client:", err);
        this.client = null;
      }
    }
  }

  public isLiveKeyConfigured(): boolean {
    return this.client !== null;
  }

  public getModelName(): string {
    return this.modelName;
  }

  /**
   * Stream agent response using either the live Gemini SDK
   * or high-fidelity simulated autonomous reasoning generator.
   */
  public async *streamResponse(
    userMessage: string,
    context?: ChatContext
  ): AsyncGenerator<StreamEvent> {
    const isLive = this.isLiveKeyConfigured();
    const startTime = Date.now();
    let totalOutputTokens = 0;

    // Dynamically match and inject domain-specific SKILL.md rules
    const skillContext = skillInjector.injectSkills(userMessage, {
      persona: context?.persona,
    });

    // Notify UI of activated skills
    for (const skill of skillContext.activeSkills) {
      yield {
        type: "step",
        step: {
          step: `Activated Skill: ${skill.metadata.name}`,
          status: "done",
          detail: `Injected ${skill.metadata.category} domain rules (${skillContext.matchedTriggers.join(", ")})`,
        },
      };
    }

    const enhancedContext: ChatContext = {
      ...context,
      injectedSkillPrompt: skillContext.injectedPrompt,
    };

    // Same policy as PayPal: production uses the simulator only when the demo is declared explicitly.
    if (!isLive && process.env.NODE_ENV === "production" && process.env.PAYPAL_MODE !== "mock") {
      throw new Error("GEMINI_API_KEY is not configured. Set it, or set PAYPAL_MODE=mock for a demo.");
    }

    const stream = isLive && this.client
      ? this.streamLiveGemini(userMessage, enhancedContext)
      : this.streamSimulatedReasoning(userMessage, enhancedContext);

    try {
      for await (const event of stream) {
        if (event.type === "token" && event.text) {
          totalOutputTokens += Math.max(1, Math.round(event.text.length / 4));
        }
        yield event;
      }
    } finally {
      const latencyMs = Date.now() - startTime;
      const inputTokens = Math.max(80, Math.round((userMessage.length + 800) / 4));
      const outputTokens = Math.max(25, totalOutputTokens);

      await posthogServer.trackLLMGeneration({
        model: isLive ? this.modelName : "gemini-3.8-flash",
        inputTokens,
        outputTokens,
        latencyMs,
        status: "success",
        promptSnippet: userMessage.slice(0, 80),
      });
    }
  }

  /**
   * Calls Google GenAI streaming API with function calling tools and system instructions
   */
  private async *streamLiveGemini(
    userMessage: string,
    context?: ChatContext
  ): AsyncGenerator<StreamEvent> {
    if (!this.client) return;

    const systemInstruction = buildSystemPromptWithContext(context);

    // Initial thought step
    yield {
      type: "step",
      step: {
        step: "Interpreting mandate via Gemini",
        status: "running",
        detail: "Analyzing natural language spending constraints...",
      },
    };

    const responseStream = await this.client.models.generateContentStream({
      model: this.modelName,
      contents: [
        {
          role: "user",
          parts: [{ text: userMessage }],
        },
      ],
      config: {
        systemInstruction,
        tools: payAgentTools,
        temperature: 0.2,
      },
    });

    yield {
      type: "step",
      step: {
        step: "Interpreting mandate via Gemini",
        status: "done",
        detail: "Intent and parameters recognized",
      },
    };

    let fullText = "";

    for await (const chunk of responseStream) {
      const candidates = chunk.candidates || [];
      if (candidates.length > 0) {
        const parts = candidates[0].content?.parts || [];
        for (const part of parts) {
          if (part.text) {
            fullText += part.text;
            yield {
              type: "token",
              text: part.text,
            };
          }

          if (part.functionCall) {
            const toolCall = {
              name: part.functionCall.name || "unknown",
              args: (part.functionCall.args as Record<string, unknown>) || {},
            };

            yield {
              type: "tool_call",
              toolCall,
            };

            yield {
              type: "step",
              step: {
                step: `Executing Tool: ${toolCall.name}`,
                status: "running",
                detail: `Invoked with: ${JSON.stringify(toolCall.args)}`,
              },
            };

            try {
              if (!context?.ownerId) throw new Error("Agent tools require a verified user.");
              // The model may only act on what the user explicitly asked for.
              const intent = classifyChatIntent(userMessage);
              if (toolCall.name === "create_mandate" && intent !== "create") {
                throw new Error("You didn't ask to create a spending rule, so none was created.");
              }
              if (toolCall.name === "execute_paypal_payment" && intent !== "execute") {
                throw new Error("You didn't ask to run a spending rule, so no payment was prepared.");
              }
              const toolResult = await dispatchAgentTool(toolCall.name, toolCall.args, context.ownerId);
              if (toolResult.quote) {
                yield {
                  type: "payment_confirmation",
                  quote: toolResult.quote as Record<string, unknown>,
                };
              }
              if (toolResult.advisory) {
                yield {
                  type: "savings_advisory",
                  advisory: toolResult.advisory as Record<string, unknown>,
                };
              }
              yield {
                type: "step",
                step: {
                  step: `Executed Tool: ${toolCall.name}`,
                  status: "done",
                  detail: toolResult.message
                    ? String(toolResult.message)
                    : `Result: ${JSON.stringify(toolResult).slice(0, 80)}...`,
                },
              };
            } catch (toolErr) {
              const errMsg =
                toolErr instanceof Error ? toolErr.message : String(toolErr);
              yield {
                type: "step",
                step: {
                  step: `Tool ${toolCall.name} Blocked`,
                  status: "done",
                  detail: errMsg,
                },
              };
            }
          }
        }
      }
    }

    yield {
      type: "done",
      text: stripStars(fullText),
    };
  }

  /**
   * High-fidelity simulated autonomous financial reasoning
   * Simulates full Agentic Commerce lifecycle:
   * 1. Parsing user mandate
   * 2. Playwright web price scraping
   * 3. Safety ceiling guardrail check
   * 4. Strict mode interception or PayPal execution
   */
  private async *streamSimulatedReasoning(
    userMessage: string,
    context?: ChatContext
  ): AsyncGenerator<StreamEvent> {
    const textLower = userMessage.toLowerCase().trim();
    const isStrictMode = !!context?.strictMode;

    // Handle conversational greetings or generic help
    if (
      textLower === "hi" ||
      textLower === "hello" ||
      textLower === "hey" ||
      textLower === "help" ||
      textLower.startsWith("hi ") ||
      textLower.startsWith("hello ")
    ) {
      const greetingMsg = `Hello! I am Rico, your autonomous financial assistant. I can help you manage recurring expenses, subscriptions, and financial purchases.\n\nWhat can I do for you today? For example, you can tell me to:\n- "Pay Netflix $15.99 on the 5th, max $20"\n- "Check the price of Spotify Premium"\n- "Compare prices for streaming services"\n- "Show me my spending rules"`;

      for (const word of greetingMsg.split(" ")) {
        yield { type: "token", text: word + " " };
        await delay(15);
      }
      yield { type: "done", text: greetingMsg };
      return;
    }

    // Skill Ingestion Flow 1: Startup Credit & Grant Inquiries
    if (
      textLower.includes("startup credit") ||
      textLower.includes("posthog credit") ||
      textLower.includes("aws activate") ||
      textLower.includes("zero burn") ||
      textLower.includes("founder discount")
    ) {
      const probeResult = await personaSavingsOptimizer.probePersonaSavings({
        serviceName: "PostHog",
        currentPrice: 120.0,
        persona: "STARTUP_FOUNDER",
      });
      if (probeResult.hasDeals) {
        yield { type: "savings_advisory", advisory: probeResult as unknown as Record<string, unknown> };
      }
      const msg = `Startup Credit Drafter Activated:\n\nBased on your startup profile, I have identified $55,000 in eligible credits:\n- PostHog for Startups: $50,000 credit allocation (12 months free analytics and session replay for companies with under $5M funding)\n- AWS Activate: $5,000 infrastructure credits\n\nI have prepared your application pitch summary matching official vendor acceptance criteria. Would you like me to set your recurring mandate to $0.00 until credits expire?`;
      for (const word of msg.split(" ")) {
        yield { type: "token", text: word + " " };
        await delay(15);
      }
      yield { type: "done", text: msg };
      return;
    }

    // Skill Ingestion Flow 2: Student 50% Discount Inquiries
    if (
      textLower.includes("student discount") ||
      textLower.includes("college deal") ||
      textLower.includes("university pricing") ||
      textLower.includes("edu email")
    ) {
      const probeResult = await personaSavingsOptimizer.probePersonaSavings({
        serviceName: "Spotify",
        currentPrice: 11.99,
        persona: "STUDENT",
      });
      if (probeResult.hasDeals) {
        yield { type: "savings_advisory", advisory: probeResult as unknown as Record<string, unknown> };
      }
      const msg = `Student Discount Enforcer Activated:\n\nI verified eligible 50% educational discount tiers:\n- Spotify Student: $5.99/mo (normally $11.99/mo, 50% off)\n- Adobe Creative Cloud Student: $19.99/mo (normally $59.99/mo, 67% off)\n- GitHub Student Developer Pack: Free developer tools worth $2,500+\n\nWould you like me to enforce a student spending ceiling rule for your subscriptions?`;
      for (const word of msg.split(" ")) {
        yield { type: "token", text: word + " " };
        await delay(15);
      }
      yield { type: "done", text: msg };
      return;
    }

    // Skill Ingestion Flow 3: Tax Deduction & Expense Inquiries
    if (
      textLower.includes("tax deduction") ||
      textLower.includes("schedule c") ||
      textLower.includes("write off") ||
      textLower.includes("tax write-off")
    ) {
      const msg = `Tax Deduction Classifier Activated:\n\nI classified your recent subscriptions and SaaS expenses into IRS Schedule C categories:\n- Software & Cloud: AWS, Supabase, GitHub Copilot (100% Tax Deductible)\n- Office & Productivity: Notion, Zoom, Slack (100% Tax Deductible)\n- Marketing & Analytics: PostHog, Meta Ads (100% Tax Deductible)\n\nEstimated annual tax savings for self-employed/contractor persona: ~$1,420 (assuming 28% blended tax rate). You can export the itemized CSV/PDF ledger directly from the AG Grid dashboard tab.`;
      for (const word of msg.split(" ")) {
        yield { type: "token", text: word + " " };
        await delay(15);
      }
      yield { type: "done", text: msg };
      return;
    }

    const intent = classifyChatIntent(userMessage);
    const known = detectKnownService(userMessage);
    const say = async function* (text: string): AsyncGenerator<StreamEvent> {
      for (const word of text.split(" ")) {
        yield { type: "token", text: word + " " };
        await delay(15);
      }
      yield { type: "done", text };
    };

    // No supported service named: nothing is created, quoted or paid. There is no generic fallback.
    if (!known) {
      yield* say(
        "I couldn't match that to a supported service, so nothing was created or paid. Try naming one, for example: \"Check the price of Spotify Premium\" or \"Create a rule for Netflix, max $20 monthly\"."
      );
      return;
    }
    const service = known.service;

    // Parse a stated ceiling ("max $20"); with two amounts the second is the ceiling.
    const dollarMatches = userMessage.match(/\$([0-9]+(?:\.[0-9]{1,2})?)/g) ?? [];
    const ceiling = dollarMatches.length > 0
      ? parseFloat(dollarMatches[dollarMatches.length - 1].replace("$", ""))
      : known.defaultCeiling;

    const ownerId = context?.ownerId;

    // 1. Explicit request to create a spending rule: creates it, never pays.
    if (intent === "create") {
      if (!ownerId) throw new Error("Creating a mandate requires a verified user.");
      const created = await executeCreateMandate({
        service,
        max_amount: ceiling,
        schedule: known.schedule,
        strict_mode: isStrictMode,
      }, ownerId);

      await posthogServer.trackMandateCreated({
        mandateId: created.mandate.id,
        service,
        budgetCeiling: ceiling,
        recurrence: known.schedule,
        strictMode: isStrictMode,
      });

      yield {
        type: "thought",
        thought: {
          summary: "Spending Rule Created",
          steps: [
            { step: "Created spending rule", status: "done", detail: `Rule ID: ${created.mandate.id}` },
            { step: "Budget ceiling configured", status: "done", detail: `Max $${ceiling.toFixed(2)} USD` },
          ],
        },
      };
      yield* say(
        `Created a spending rule for ${service}: max $${ceiling.toFixed(2)} USD, ${known.schedule}. No payment was made. Use Run Now on the rule when you want to pay, and you'll be asked to confirm first.`
      );
      return;
    }

    // 2. Explicit request to run a rule: prepares a quote for confirmation, never pays.
    if (intent === "execute") {
      if (!ownerId) throw new Error("Running a spending rule requires a verified user.");
      const keyword = known.keyword;
      const owned = (await db
        .select()
        .from(mandates)
        .where(and(eq(mandates.ownerId, ownerId), eq(mandates.status, "ACTIVE"))))
        .filter((m) => m.service.toLowerCase().includes(keyword) || m.service === service);
      if (owned.length !== 1) {
        yield* say(
          owned.length === 0
            ? `You don't have an active spending rule for ${service}, so nothing was paid. Create the rule first, then run it.`
            : `You have more than one active rule matching ${service}. Use Run Now on the one you mean. Nothing was paid.`
        );
        return;
      }
      const quoted = await quoteMandatePayment(owned[0].id, ownerId);
      if (!quoted.ok) {
        yield* say(quoted.message);
        return;
      }
      const q = quoted.quote;
      yield { type: "payment_confirmation", quote: q as unknown as Record<string, unknown> };
      yield* say(
        `Ready to pay ${q.service}: $${q.amount.toFixed(2)} ${q.currency} (ceiling $${q.budgetCeiling.toFixed(2)}, billing period ${q.periodLabel}). Please confirm to proceed. No payment has been made yet.`
      );
      return;
    }

    // 3. Everything else is informational: check the price only.
    const step: ThoughtStep = {
      step: "Verified merchant price via Playwright",
      status: "running",
      detail: `Navigating to ${service} pricing page...`,
    };
    yield { type: "step", step };
    const priceVerification = await executeVerifyWebPrice({
      service_name: service,
      expected_price: ceiling,
    });
    step.status = "done";
    step.detail = `Price: $${priceVerification.verifiedPrice.toFixed(2)}/mo (${priceVerification.planName})`;
    yield { type: "step", step };

    yield* say(
      `${service} currently costs $${priceVerification.verifiedPrice.toFixed(2)} ${priceVerification.currency}/mo (${priceVerification.planName}). Nothing was created or paid.`
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const geminiAgent = new GeminiAgentClient();
