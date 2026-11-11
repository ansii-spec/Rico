/**
 * PayPal provider safety tests. Every fetch is answered by the stub below, and
 * credentials are fake, so nothing can reach PayPal.
 */
import assert from "node:assert/strict";
import {
  derivePayPalRequestId,
  executeMandatePayment,
  payPalOAuth,
  payPalOrders,
  PayPalConfigError,
  PayPalPaymentError,
} from "./index";

type Call = { url: string; headers: Record<string, string>; body?: string };
type Reply = (call: Call, signal?: AbortSignal) => Promise<Response> | Response;

const FAKE_CREDENTIALS = { id: "fake-client-id-123456", secret: "fake-client-secret-123456" };
const ORDER_ID = "5O190127TN364715T";
let calls: Call[] = [];

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

const orderReply = () =>
  json(201, {
    id: ORDER_ID,
    status: "CREATED",
    intent: "CAPTURE",
    purchase_units: [{ amount: { currency_code: "USD", value: "10.00" } }],
  });

const captureReply = (status = "COMPLETED", value = "10.00", httpStatus = 201) =>
  json(httpStatus, {
    id: ORDER_ID,
    status: "COMPLETED",
    payer: { email_address: "payer@example.test", payer_id: "PAYER1" },
    purchase_units: [
      { payments: { captures: [{ id: "CAP-REAL-1", status, amount: { currency_code: "USD", value } }] } },
    ],
  });

const issueReply = (status: number, issue: string) =>
  json(status, { name: "ERROR", debug_id: "debug-1", details: [{ issue }] });

/** Routes by endpoint. An unexpected URL fails the test instead of leaving the process. */
function stub(routes: { token?: Reply; create?: Reply; capture?: Reply }) {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body as string | undefined,
    };
    calls.push(call);
    const signal = init?.signal ?? undefined;
    if (call.url.endsWith("/v1/oauth2/token")) {
      return routes.token
        ? routes.token(call, signal)
        : json(200, { access_token: "fake-token", expires_in: 3600 });
    }
    if (call.url.endsWith("/v2/checkout/orders")) {
      return routes.create ? routes.create(call, signal) : orderReply();
    }
    if (call.url.endsWith("/capture")) {
      return routes.capture ? routes.capture(call, signal) : captureReply();
    }
    throw new assert.AssertionError({ message: `Unexpected request: ${call.url}` });
  }) as typeof fetch;
}

function setEnv(values: Record<string, string | undefined>) {
  const env = process.env as Record<string, string | undefined>;
  for (const name of ["PAYPAL_MODE", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_ENVIRONMENT", "PAYPAL_TIMEOUT_MS", "NODE_ENV"]) {
    delete env[name];
  }
  for (const [name, value] of Object.entries(values)) env[name] = value;
  payPalOAuth.clearCache();
  calls = [];
}

const realEnv = () =>
  setEnv({ PAYPAL_CLIENT_ID: FAKE_CREDENTIALS.id, PAYPAL_CLIENT_SECRET: FAKE_CREDENTIALS.secret, PAYPAL_ENVIRONMENT: "sandbox" });

const pay = (key = "alert:1") =>
  executeMandatePayment({ serviceName: "Test", verifiedPrice: 10, budgetCeiling: 20, paymentAttemptKey: key });

async function failure(run: Promise<unknown>): Promise<PayPalPaymentError> {
  try {
    await run;
  } catch (error) {
    assert.ok(error instanceof PayPalPaymentError, `expected PayPalPaymentError, got ${error}`);
    return error;
  }
  throw new assert.AssertionError({ message: "expected the payment to fail" });
}

const captureCalls = () => calls.filter((call) => call.url.endsWith("/capture"));

const tests: Array<[string, () => Promise<void>]> = [
  ["success keeps the response shape and real identifiers", async () => {
    realEnv();
    stub({});
    const result = await pay();
    assert.equal(result.success, true);
    assert.equal(result.orderId, ORDER_ID);
    assert.equal(result.captureId, "CAP-REAL-1");
    assert.equal(result.receipt.captureId, "CAP-REAL-1");
    assert.equal(result.receipt.status, "COMPLETED");
    assert.equal(result.receipt.mode, "LIVE_SANDBOX");
    assert.equal(result.receipt.payerEmail, "payer@example.test");
  }],
  ["real receipt holds only PayPal's data, with no invented payer or card", async () => {
    realEnv();
    stub({
      capture: () =>
        json(201, {
          id: ORDER_ID,
          status: "COMPLETED",
          purchase_units: [
            { payments: { captures: [{ id: "CAP-REAL-1", status: "COMPLETED", amount: { currency_code: "USD", value: "10.00" } }] } },
          ],
        }),
    });
    const { receipt } = await pay();
    assert.equal(receipt.payerEmail, "");
    assert.equal(receipt.sandboxAuthCode, "CAP-REAL-1");
    assert.equal(receipt.fundingRail, "PAYPAL");
    assert.equal(receipt.paymentMethod, "PayPal");
    assert.equal(receipt.cardLastFour, undefined);
  }],
  ["real mode refuses card rails before contacting PayPal", async () => {
    for (const fundingRail of ["VISA", "MASTERCARD"] as const) {
      realEnv();
      stub({});
      await assert.rejects(
        executeMandatePayment({ serviceName: "Test", verifiedPrice: 10, budgetCeiling: 20, fundingRail, paymentAttemptKey: "card:1" }),
        PayPalConfigError
      );
      assert.equal(calls.length, 0);
    }
  }],
  ["create and capture send separate, valid request IDs and ask for full responses", async () => {
    realEnv();
    stub({});
    await pay();
    const [, create, capture] = calls;
    assert.equal(create.headers["paypal-request-id"], derivePayPalRequestId("alert:1", "create"));
    assert.equal(capture.headers["paypal-request-id"], derivePayPalRequestId("alert:1", "capture"));
    assert.notEqual(create.headers["paypal-request-id"], capture.headers["paypal-request-id"]);
    assert.ok(create.headers["paypal-request-id"].length <= 108);
    assert.ok(capture.headers["paypal-request-id"].length <= 108);
    assert.equal(create.headers.prefer, "return=representation");
    assert.equal(capture.headers.prefer, "return=representation");
  }],
  ["duplicate retry reuses both IDs and returns the original capture", async () => {
    realEnv();
    const replays = new Map<string, number>();
    stub({
      capture: (call) => {
        const id = call.headers["paypal-request-id"];
        replays.set(id, (replays.get(id) ?? 0) + 1);
        return captureReply("COMPLETED", "10.00", replays.get(id) === 1 ? 201 : 200);
      },
    });
    const first = await pay("alert:retry");
    const second = await pay("alert:retry");
    assert.equal(second.captureId, first.captureId);
    assert.equal(replays.size, 1, "retry must reuse one capture request ID");
    const createIds = calls.filter((c) => c.url.endsWith("/orders")).map((c) => c.headers["paypal-request-id"]);
    assert.equal(createIds[0], createIds[1]);
  }],
  ["different logical payments get different IDs", async () => {
    assert.notEqual(derivePayPalRequestId("alert:1", "capture"), derivePayPalRequestId("alert:2", "capture"));
  }],
  ["capture without a key still uses a stable ID based on the order", async () => {
    realEnv();
    stub({});
    await payPalOrders.captureOrder(ORDER_ID, { verifiedPrice: 10 });
    await payPalOrders.captureOrder(ORDER_ID, { verifiedPrice: 10 });
    const [a, b] = captureCalls();
    assert.equal(a.headers["paypal-request-id"], b.headers["paypal-request-id"]);
  }],
  ["blank attempt key is rejected before create is sent", async () => {
    realEnv();
    stub({});
    await assert.rejects(pay("   "), PayPalConfigError);
    assert.equal(calls.filter((c) => c.url.endsWith("/orders")).length, 0);
  }],
  ["422 INSTRUMENT_DECLINED is a confirmed decline with identifiers", async () => {
    realEnv();
    stub({ capture: () => issueReply(422, "INSTRUMENT_DECLINED") });
    const error = await failure(pay());
    assert.equal(error.kind, "CONFIRMED_DECLINE");
    assert.equal(error.issue, "INSTRUMENT_DECLINED");
    assert.equal(error.orderId, ORDER_ID);
    assert.equal(error.debugId, "debug-1");
    assert.equal(error.requestId, derivePayPalRequestId("alert:1", "capture"));
  }],
  ["capture status DECLINED in a 201 is a confirmed decline and keeps the capture ID", async () => {
    realEnv();
    stub({ capture: () => captureReply("DECLINED") });
    const error = await failure(pay());
    assert.equal(error.kind, "CONFIRMED_DECLINE");
    assert.equal(error.captureId, "CAP-REAL-1");
  }],
  ["a real timeout is unknown and keeps the order ID", async () => {
    realEnv();
    process.env.PAYPAL_TIMEOUT_MS = "20";
    stub({
      capture: (_call, signal) =>
        new Promise((_resolve, reject) => {
          assert.ok(signal, "capture must have a timeout signal");
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    });
    const error = await failure(pay());
    assert.equal(error.kind, "UNKNOWN_OUTCOME");
    assert.equal(error.orderId, ORDER_ID);
    assert.match(error.message, /TimeoutError/);
  }],
  ["network interruption is unknown", async () => {
    realEnv();
    stub({ capture: () => { throw new TypeError("connection reset"); } });
    assert.equal((await failure(pay())).kind, "UNKNOWN_OUTCOME");
  }],
  ["response body lost mid-read is unknown", async () => {
    realEnv();
    stub({
      capture: () =>
        new Response(new ReadableStream({ start: (c) => c.error(new Error("socket closed")) }), { status: 201 }),
    });
    assert.equal((await failure(pay())).kind, "UNKNOWN_OUTCOME");
  }],
  ["server errors are unknown, even if the body names a decline", async () => {
    for (const status of [500, 502, 503, 504]) {
      realEnv();
      stub({ capture: () => issueReply(status, "INSTRUMENT_DECLINED") });
      const error = await failure(pay());
      assert.equal(error.kind, "UNKNOWN_OUTCOME", `HTTP ${status}`);
      assert.equal(error.httpStatus, status);
    }
  }],
  ["other client errors and non-decline issues are never declines", async () => {
    for (const [status, issue] of [
      [422, "ORDER_ALREADY_CAPTURED"],
      [422, "ORDER_NOT_APPROVED"],
      [409, "CONFLICT"],
      [429, "RATE_LIMIT_REACHED"],
      [401, "INVALID_TOKEN"],
    ] as Array<[number, string]>) {
      realEnv();
      stub({ capture: () => issueReply(status, issue) });
      const error = await failure(pay());
      assert.equal(error.kind, "UNKNOWN_OUTCOME", issue);
      assert.equal(error.issue, issue);
    }
  }],
  ["ambiguous 2xx responses are unknown and invent no identifiers", async () => {
    const replies: Array<[string, () => Response]> = [
      ["pending", () => captureReply("PENDING")],
      ["accepted", () => json(202, { id: ORDER_ID, status: "PENDING" })],
      ["minimal", () => json(201, { id: ORDER_ID, status: "COMPLETED" })],
      ["unreadable", () => new Response("<html>", { status: 201 })],
      ["amount mismatch", () => captureReply("COMPLETED", "99.00")],
      ["other order", () => json(201, { id: "OTHER", purchase_units: [{ payments: { captures: [{ id: "C", status: "COMPLETED", amount: { currency_code: "USD", value: "10.00" } }] } }] })],
    ];
    for (const [label, reply] of replies) {
      realEnv();
      stub({ capture: reply });
      const error = await failure(pay());
      assert.equal(error.kind, "UNKNOWN_OUTCOME", label);
      assert.equal(error.orderId, ORDER_ID, label);
    }
  }],
  ["a pending capture preserves its capture ID", async () => {
    realEnv();
    stub({ capture: () => captureReply("PENDING") });
    const error = await failure(pay());
    assert.equal(error.captureId, "CAP-REAL-1");
    assert.equal(error.captureStatus, "PENDING");
  }],
  ["create failure does not simulate and never attempts capture", async () => {
    for (const reply of [
      () => issueReply(500, "INTERNAL_SERVER_ERROR"),
      () => { throw new TypeError("connection reset"); },
      () => json(201, { status: "CREATED" }),
    ] as Reply[]) {
      realEnv();
      stub({ create: reply });
      const error = await failure(pay());
      assert.equal(error.kind, "UNKNOWN_OUTCOME");
      assert.equal(error.operation, "create");
      assert.equal(captureCalls().length, 0);
    }
  }],
  ["OAuth failure does not simulate and sends no payment request", async () => {
    for (const reply of [
      () => json(401, { error: "invalid_client" }),
      () => { throw new TypeError("network"); },
      () => json(200, {}),
    ] as Reply[]) {
      realEnv();
      stub({ token: reply });
      const error = await failure(pay());
      assert.equal(error.operation, "oauth");
      assert.equal(error.kind, "UNKNOWN_OUTCOME");
      assert.equal(calls.length, 1);
    }
  }],
  ["errors never expose credentials or tokens", async () => {
    realEnv();
    stub({ token: () => json(401, { error: FAKE_CREDENTIALS.secret }) });
    const error = await failure(pay());
    assert.ok(!JSON.stringify({ ...error, message: error.message }).includes(FAKE_CREDENTIALS.secret));
  }],
  ["real mode refuses a simulated order ID", async () => {
    realEnv();
    stub({});
    await assert.rejects(payPalOrders.captureOrder("ORD-SANDBOX-123"), PayPalConfigError);
    assert.equal(captureCalls().length, 0);
  }],
  ["PAYPAL_MODE=mock simulates with zero network calls, even with credentials", async () => {
    realEnv();
    process.env.PAYPAL_MODE = "mock";
    stub({});
    const result = await pay();
    assert.equal(calls.length, 0);
    assert.equal(result.receipt.mode, "SIMULATED_SANDBOX");
    assert.ok(result.orderId.startsWith("ORD-SANDBOX-"));
  }],
  ["missing credentials outside production stay in mock mode", async () => {
    setEnv({});
    stub({});
    assert.equal((await pay()).receipt.mode, "SIMULATED_SANDBOX");
    assert.equal(calls.length, 0);
  }],
  ["placeholder credentials stay in mock mode", async () => {
    setEnv({ PAYPAL_CLIENT_ID: "your_paypal_client_id", PAYPAL_CLIENT_SECRET: "your_paypal_secret" });
    stub({});
    assert.equal((await pay()).receipt.mode, "SIMULATED_SANDBOX");
    assert.equal(calls.length, 0);
  }],
  ["unsafe configurations are refused with zero network calls", async () => {
    const configs: Array<Record<string, string>> = [
      { NODE_ENV: "production" },
      { PAYPAL_ENVIRONMENT: "live" },
      { PAYPAL_ENVIRONMENT: "live", PAYPAL_MODE: "mock" },
      { PAYPAL_MODE: "real" },
      { PAYPAL_MODE: "simulator" },
    ];
    for (const config of configs) {
      setEnv(config);
      stub({});
      await assert.rejects(pay(), PayPalConfigError, JSON.stringify(config));
      assert.equal(calls.length, 0);
    }
  }],
  ["production demo works only with explicit mock mode", async () => {
    setEnv({ NODE_ENV: "production", PAYPAL_MODE: "mock" });
    stub({});
    assert.equal((await pay()).receipt.mode, "SIMULATED_SANDBOX");
    assert.equal(calls.length, 0);
  }],
];

(async () => {
  // The stub opens no sockets, and timeout timers alone do not keep Node running.
  setInterval(() => {}, 1000);
  let failed = 0;
  for (const [name, run] of tests) {
    try {
      await run();
      console.log(`PASS ${name}`);
    } catch (error) {
      failed++;
      console.error(`FAIL ${name}\n`, error);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
