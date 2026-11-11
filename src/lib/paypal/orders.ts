import { createHash, randomUUID } from "crypto";
import { PayPalConfigError, PayPalPaymentError } from "./errors";
import { payPalOAuth } from "./oauth";
import {
  PayPalCreateOrderParams,
  PayPalOrderResponse,
  PayPalCaptureResponse,
  PayPalReceipt,
  FundingRail,
} from "./types";
import { resolveFundingRail } from "./vault";

/** Only these capture errors confirm a refusal. Any other error stays UNKNOWN_OUTCOME. */
const CONFIRMED_DECLINE_ISSUES = new Set([
  "INSTRUMENT_DECLINED",
  "TRANSACTION_REFUSED",
  "PAYER_CANNOT_PAY",
]);

/** Fits PayPal's 108-character limit. Retries of one payment reuse the same ID per operation. */
export function derivePayPalRequestId(
  paymentAttemptKey: string,
  operation: "create" | "capture"
): string {
  const key = paymentAttemptKey.trim();
  if (!key) throw new PayPalConfigError("paymentAttemptKey must not be blank.");
  const digest = createHash("sha256").update(`${operation}:${key}`).digest("hex");
  return `rico-${operation}-${digest}`;
}

/**
 * Real PayPal orders are paid from the buyer's PayPal account. The vaulted Visa and Mastercard
 * instruments only exist in the simulator, so a real receipt must never claim a card was charged.
 */
function assertPayPalRail(rail?: FundingRail | "AUTO", simulateDeclinePrimary?: boolean): void {
  if ((rail && rail !== "PAYPAL" && rail !== "AUTO") || simulateDeclinePrimary) {
    throw new PayPalConfigError(
      "Card rails are not connected to real PayPal yet. Use the PayPal rail."
    );
  }
}

interface PayPalErrorBody {
  debug_id?: string;
  details?: Array<{ issue?: string }>;
}

/** Sends one request with no automatic retry. A lost or unreadable response is an unknown outcome. */
async function postToPayPal<T>(
  operation: "create" | "capture",
  path: string,
  token: string,
  requestId: string,
  orderId?: string,
  body?: unknown
): Promise<{ status: number; ok: boolean; data: T | null; debugId?: string }> {
  try {
    const response = await fetch(`${payPalOAuth.getBaseUrl()}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "PayPal-Request-Id": requestId,
        // PayPal's default minimal response omits the capture details checked below.
        Prefer: "return=representation",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(payPalOAuth.getTimeoutMs()),
    });
    const text = await response.text();
    let data: T | null = null;
    try {
      data = text ? (JSON.parse(text) as T) : null;
    } catch {
      data = null;
    }
    return {
      status: response.status,
      ok: response.ok,
      data,
      debugId: response.headers.get("paypal-debug-id") ?? undefined,
    };
  } catch (err) {
    throw new PayPalPaymentError(
      `PayPal ${operation} outcome unknown: ${err instanceof Error ? err.name : "request failed"}`,
      { kind: "UNKNOWN_OUTCOME", operation, requestId, orderId }
    );
  }
}

export class PayPalOrdersClient {
  /**
   * Create an Order with intent CAPTURE (PayPal Orders v2 API)
   */
  public async createOrder(
    params: PayPalCreateOrderParams
  ): Promise<PayPalOrderResponse> {
    const currency = params.currency || "USD";
    const formattedAmount = params.amount.toFixed(2);
    const isReal = payPalOAuth.getMode() === "real";
    if (isReal) assertPayPalRail(params.fundingRail);
    const token = await payPalOAuth.getAccessToken();

    if (isReal) {
      const requestId =
        params.paymentAttemptKey !== undefined
          ? derivePayPalRequestId(params.paymentAttemptKey, "create")
          : `rico-create-${randomUUID()}`;
      const result = await postToPayPal<PayPalOrderResponse & PayPalErrorBody>(
        "create",
        "/v2/checkout/orders",
        token,
        requestId,
        undefined,
        {
          intent: "CAPTURE",
          purchase_units: [
            {
              reference_id: params.mandateId || `mandate-${Date.now()}`,
              description:
                params.description ||
                `Autonomous Mandate for ${params.serviceName}`,
              custom_id: params.customId || `payagent-${Date.now()}`,
              amount: {
                currency_code: currency,
                value: formattedAmount,
              },
            },
          ],
        }
      );

      if (!result.ok || !result.data?.id) {
        throw new PayPalPaymentError(`PayPal order creation failed with HTTP ${result.status}`, {
          kind: "UNKNOWN_OUTCOME",
          operation: "create",
          httpStatus: result.status,
          issue: result.data?.details?.[0]?.issue,
          debugId: result.data?.debug_id ?? result.debugId,
          requestId,
        });
      }
      return result.data;
    }

    // High-Fidelity Sandbox Simulator Order
    const randomSuffix = Math.floor(10000000 + Math.random() * 90000000);
    const simulatedOrderId = `ORD-SANDBOX-${randomSuffix}`;

    return {
      id: simulatedOrderId,
      status: "CREATED",
      intent: "CAPTURE",
      create_time: new Date().toISOString(),
      purchase_units: [
        {
          reference_id: params.mandateId || `mandate-${Date.now()}`,
          description:
            params.description ||
            `Autonomous Mandate for ${params.serviceName}`,
          custom_id: params.customId || `payagent-${Date.now()}`,
          amount: {
            currency_code: currency,
            value: formattedAmount,
          },
        },
      ],
      links: [
        {
          href: `https://www.sandbox.paypal.com/checkoutnow?token=${simulatedOrderId}`,
          rel: "approve",
          method: "GET",
        },
        {
          href: `${payPalOAuth.getBaseUrl()}/v2/checkout/orders/${simulatedOrderId}/capture`,
          rel: "capture",
          method: "POST",
        },
      ],
    };
  }

  /**
   * Capture authorized funds for an Order (PayPal Orders v2 Capture & Dual-Rail Vault)
   */
  public async captureOrder(
    orderId: string,
    context?: {
      serviceName?: string;
      planName?: string;
      verifiedPrice?: number;
      budgetCeiling?: number;
      fundingRail?: FundingRail | "AUTO";
      simulateDeclinePrimary?: boolean;
      paymentAttemptKey?: string;
    }
  ): Promise<{ capture: PayPalCaptureResponse; receipt: PayPalReceipt }> {
    const isReal = payPalOAuth.getMode() === "real";
    if (isReal) assertPayPalRail(context?.fundingRail, context?.simulateDeclinePrimary);
    const token = await payPalOAuth.getAccessToken();

    const railResolution = resolveFundingRail(context?.fundingRail || "AUTO", {
      simulateDeclinePrimary: context?.simulateDeclinePrimary,
    });
    const instrument = railResolution.instrument;
    const resolvedRail = railResolution.selectedRail;

    if (isReal) {
      if (orderId.startsWith("ORD-SANDBOX-")) {
        throw new PayPalConfigError("A simulated order cannot be captured in real PayPal mode.");
      }

      // An order has one capture, so its ID is a stable fallback for callers without a key.
      const requestId = derivePayPalRequestId(
        context?.paymentAttemptKey ?? `order:${orderId}`,
        "capture"
      );
      const result = await postToPayPal<PayPalOrderResponse & PayPalErrorBody & {
        payer?: { email_address?: string; payer_id?: string };
      }>(
        "capture",
        `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
        token,
        requestId,
        orderId
      );
      const data = result.data;
      const issues = (data?.details ?? []).map((detail) => detail.issue);
      const declinedIssue = issues.find(
        (issue): issue is string => !!issue && CONFIRMED_DECLINE_ISSUES.has(issue)
      );
      const failureBase = {
        operation: "capture" as const,
        httpStatus: result.status,
        issue: declinedIssue ?? issues.find(Boolean),
        debugId: data?.debug_id ?? result.debugId,
        requestId,
        orderId,
      };

      if (!result.ok) {
        const confirmed = result.status === 422 && !!declinedIssue;
        throw new PayPalPaymentError(
          confirmed
            ? `PayPal declined the capture: ${declinedIssue}`
            : `PayPal capture outcome unknown: HTTP ${result.status}`,
          { ...failureBase, kind: confirmed ? "CONFIRMED_DECLINE" : "UNKNOWN_OUTCOME" }
        );
      }

      const captureUnit = data?.purchase_units?.[0]?.payments?.captures?.[0];
      const captureStatus: string | undefined = captureUnit?.status;
      const captureDetails = { ...failureBase, captureId: captureUnit?.id, captureStatus };

      if (captureStatus === "DECLINED" || captureStatus === "FAILED") {
        throw new PayPalPaymentError(`PayPal capture ${captureStatus}`, {
          ...captureDetails,
          kind: "CONFIRMED_DECLINE",
        });
      }
      const capturedAmount = Number(captureUnit?.amount?.value);
      const expectedAmount =
        context?.verifiedPrice === undefined ? undefined : Number(context.verifiedPrice);
      if (
        !data ||
        !captureUnit?.id ||
        captureStatus !== "COMPLETED" ||
        !Number.isFinite(capturedAmount) ||
        (data.id !== undefined && data.id !== orderId) ||
        (expectedAmount !== undefined && Math.abs(capturedAmount - expectedAmount) >= 0.005)
      ) {
        throw new PayPalPaymentError(
          "PayPal capture outcome unknown: response is not a matching completed capture",
          { ...captureDetails, kind: "UNKNOWN_OUTCOME" }
        );
      }

      const captureId = captureUnit.id;
      const amountValue = captureUnit.amount.value;
      const currency = captureUnit.amount.currency_code;

      const capture: PayPalCaptureResponse = {
        id: captureId,
        orderId,
        status: "COMPLETED",
        amount: {
          currency_code: currency,
          value: amountValue,
        },
        payer: {
          email_address: data.payer?.email_address ?? "",
          payer_id: data.payer?.payer_id ?? "",
        },
        transactionId: captureId,
        // PayPal returns no authorization code for an order capture; the capture ID is the reference.
        authorizationCode: captureId,
        create_time: captureUnit.create_time ?? new Date().toISOString(),
        fundingRail: "PAYPAL",
      };

      const receipt: PayPalReceipt = {
        orderId: capture.orderId,
        captureId: capture.id,
        service: context?.serviceName || "Merchant Service",
        planName:
          context?.planName ||
          `${context?.serviceName || "Merchant"} Subscription`,
        verifiedPrice: context?.verifiedPrice ?? parseFloat(amountValue),
        budgetCeiling: context?.budgetCeiling ?? parseFloat(amountValue),
        currency,
        paymentMethod: "PayPal",
        status: "COMPLETED",
        timestamp: new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
        payerEmail: capture.payer.email_address,
        sandboxAuthCode: capture.authorizationCode,
        mode: "LIVE_SANDBOX",
        fundingRail: "PAYPAL",
        isCascaded: false,
      };

      return { capture, receipt };
    }

    // High-Fidelity Sandbox Simulator Capture with Dual-Rail Support
    const randomCap = Math.floor(10000000 + Math.random() * 90000000);
    const captureId = `CAP-${randomCap}`;
    const authCode = `AUTH-${Math.floor(1000 + Math.random() * 9000)}`;
    const verifiedPrice = context?.verifiedPrice ?? 15.49;
    const budgetCeiling = context?.budgetCeiling ?? 20.0;
    const serviceName = context?.serviceName || "Netflix Standard HD";

    const capture: PayPalCaptureResponse = {
      id: captureId,
      orderId,
      status: "COMPLETED",
      amount: {
        currency_code: "USD",
        value: verifiedPrice.toFixed(2),
      },
      payer: {
        email_address: "buyer-sandbox@payagent.internal",
        payer_id: "PAYER-SB-984210",
      },
      transactionId: captureId,
      authorizationCode: authCode,
      create_time: new Date().toISOString(),
      fundingRail: resolvedRail,
      cardLastFour: instrument.lastFour,
      routedGateway: instrument.issuerName,
    };

    const receipt: PayPalReceipt = {
      orderId,
      captureId,
      service: serviceName,
      planName: context?.planName || `${serviceName} Plan`,
      verifiedPrice,
      budgetCeiling,
      currency: "USD",
      paymentMethod:
        resolvedRail === "PAYPAL"
          ? "PayPal Sandbox Wallet (Connected Account)"
          : `${instrument.label} (•••• ${instrument.lastFour})`,
      status: "COMPLETED",
      timestamp: new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
      payerEmail: "buyer-sandbox@payagent.internal",
      sandboxAuthCode: authCode,
      mode: "SIMULATED_SANDBOX",
      fundingRail: resolvedRail,
      cardLastFour: instrument.lastFour,
      routedGateway: instrument.issuerName,
      isCascaded: railResolution.isCascaded,
    };

    return { capture, receipt };
  }
}

export const payPalOrders = new PayPalOrdersClient();
