import assert from "node:assert/strict";
import { it } from "node:test";
import { createHmac, randomBytes } from "node:crypto";
import { RazorpayProvider } from "../src/billing/provider";
import { ServiceError } from "../src/services/errors";
it("sends a stable refund idempotency header and receipt on the original payment only", async context => {
  const calls: { url: string; body: Record<string, unknown>; key: string | null }[] = [];
  context.mock.method(globalThis, "fetch", async (url: string | URL | Request, options: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(options.body)), key: new Headers(options.headers).get("X-Refund-Idempotency") });
    return Response.json({ id: "rfnd_fixture", payment_id: "pay_fixture", amount: 4000, currency: "INR", receipt: "refund_receipt_fixture", status: "pending", created_at: 1793613600, notes: [] });
  });
  const provider = new RazorpayProvider({ RAZORPAY_KEY_ID: "rzp_test_fixture", RAZORPAY_KEY_SECRET: "fixture", RAZORPAY_MODE: "test" });
  await provider.createRefund("pay_fixture", 4000, "refund_receipt_fixture", "refund_key_fixture");
  assert.equal(calls[0]!.url, "https://api.razorpay.com/v1/payments/pay_fixture/refund");
  assert.equal(calls[0]!.key, "refund_key_fixture"); assert.equal(calls[0]!.body.receipt, "refund_receipt_fixture"); assert.equal(calls[0]!.body.amount, 4000);
  await assert.rejects(provider.createRefund("pay_fixture", -1, "refund_receipt_fixture", "refund_key_fixture")); assert.equal(calls.length, 1);
});
it("preserves Retry-After on account-wide 429 responses without resending GETs", async context => {
  let calls = 0;
  context.mock.method(globalThis, "fetch", async () => { calls++; return new Response("", { status: 429, headers: { "Retry-After": "120" } }); });
  const provider = new RazorpayProvider({ RAZORPAY_KEY_ID: "rzp_test_fixture", RAZORPAY_KEY_SECRET: "fixture", RAZORPAY_MODE: "test" });
  await assert.rejects(provider.payment("pay_fixture"), error => error instanceof ServiceError && error.code === "PROVIDER_RATE_LIMITED" && error.rateLimitScope === "global" && error.retryAfterMs === 120000);
  assert.equal(calls, 1);
});
const secret = randomBytes(32).toString("hex"),
  webhookSecret = randomBytes(32).toString("hex");
const environment = {
  RAZORPAY_KEY_ID: "rzp_test_fixture",
  RAZORPAY_KEY_SECRET: secret,
  RAZORPAY_WEBHOOK_SECRET: webhookSecret,
  RAZORPAY_MODE: "test",
  NODE_ENV: "development",
};
it("verifies the documented payment|stored-subscription signature and exact raw webhook bytes", () => {
  const provider = new RazorpayProvider(environment);
  const signature = createHmac("sha256", secret)
    .update("pay_fixture|sub_fixture")
    .digest("hex");
  assert.equal(
    provider.verifyCheckout("pay_fixture", "sub_fixture", signature),
    true,
  );
  assert.equal(
    provider.verifyCheckout("sub_fixture", "pay_fixture", signature),
    false,
  );
  const raw = Buffer.from('{ "event": "subscription.charged" }');
  const signed = createHmac("sha256", webhookSecret).update(raw).digest("hex");
  assert.equal(provider.verifyWebhook(raw, signed), true);
  assert.equal(
    provider.verifyWebhook(
      Buffer.from('{"event":"subscription.charged"}'),
      signed,
    ),
    false,
  );
});
it("keeps missing or wrong-mode provider credentials unavailable", () => {
  assert.equal(new RazorpayProvider({}).available, false);
  assert.equal(
    new RazorpayProvider({
      ...environment,
      RAZORPAY_KEY_ID: "rzp_live_fixture",
    }).available,
    false,
  );
  assert.equal(
    new RazorpayProvider({
      ...environment,
      RAZORPAY_MODE: "live",
      RAZORPAY_KEY_ID: "rzp_live_fixture",
    }).available,
    false,
  );
});
it("can provision plans with API keys while keeping checkout disabled until the webhook is configured", () => {
  const provider = new RazorpayProvider({
    ...environment,
    RAZORPAY_WEBHOOK_SECRET: "",
  });
  assert.equal(provider.apiAvailable, true);
  assert.equal(provider.available, false);
});
it("creates and discovers Razorpay plans with integer amounts, intervals and durable references", async (context) => {
  let posted = false;
  context.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      assert.equal(url.origin, "https://api.razorpay.com");
      assert.equal(url.pathname, "/v1/plans");
      const plan = {
        id: "plan_fixture",
        interval: 1,
        period: "yearly",
        item: { amount: 999000, currency: "INR" },
        notes: { hrmsPlanReference: "fixture-reference" },
      };
      if (init?.method === "POST") {
        posted = true;
        const body = JSON.parse(String(init.body));
        assert.equal(body.item.amount, 999000);
        assert.equal(body.period, "yearly");
        assert.equal(body.interval, 1);
        assert.equal(body.notes.hrmsPlanReference, "fixture-reference");
        assert.equal("addons" in body, false);
        return Response.json(plan);
      }
      assert.equal(url.searchParams.get("count"), "100");
      return Response.json({
        items: [plan, { ...plan, id: "plan_unrelated", notes: [] }],
      });
    },
  );
  const provider = new RazorpayProvider(environment);
  await provider.createPlan(
    {
      name: "Essentials",
      interval: "YEARLY",
      amountMinor: 999000,
      currency: "INR",
    },
    "fixture-reference",
  );
  assert.equal(
    (await provider.findPlan("fixture-reference"))?.id,
    "plan_fixture",
  );
  assert.equal(posted, true);
});
it("paginates invoices past the first hundred without assuming history is complete", async (context) => {
  const pages: number[] = [];
  context.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input)); const skip = Number(url.searchParams.get("skip")); pages.push(skip);
    return Response.json({ items: Array.from({ length: skip === 0 ? 100 : 1 }, (_, index) => ({ id: `inv_${skip + index}`, subscription_id: "sub_fixture", payment_id: null, status: "issued", currency: "INR", amount_paid: 0, created_at: 1700000000 })) });
  });
  const provider = new RazorpayProvider(environment);
  assert.equal((await provider.invoices("sub_fixture", 0)).length, 101); assert.deepEqual(pages, [0, 100]);
});
it("uses the documented HTTPS REST paths and server-controlled subscription request", async (context) => {
  let requests = 0;
  context.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      requests++;
      const url = new URL(String(input));
      assert.equal(url.origin, "https://api.razorpay.com");
      assert.ok(
        new Headers(init?.headers).get("authorization")?.startsWith("Basic "),
      );
      if (url.pathname === "/v1/plans/plan_fixture")
        return Response.json({
          id: "plan_fixture",
          period: "monthly",
          interval: 1,
          item: { amount: 10000, currency: "INR" },
        });
      if (url.pathname === "/v1/invoices") {
        assert.equal(url.searchParams.get("subscription_id"), "sub_fixture");
        return Response.json({ items: [] });
      }
      const body = JSON.parse(String(init?.body));
      assert.equal(body.plan_id, "plan_fixture");
      assert.equal(body.quantity, 1);
      assert.equal(body.total_count, 12);
      assert.equal(body.notes.localSubscriptionId, "local_fixture");
      assert.equal("amount" in body, false);
      return Response.json({
        id: "sub_fixture",
        plan_id: body.plan_id,
        status: "created",
        current_start: null,
        current_end: null,
        paid_count: 0,
        notes: body.notes,
      });
    },
  );
  const provider = new RazorpayProvider(environment);
  assert.equal((await provider.fetchPlan("plan_fixture")).item.currency, "INR");
  assert.equal(
    (
      await provider.createSubscription(
        "plan_fixture",
        12,
        "local_fixture",
        "org_fixture",
      )
    ).status,
    "created",
  );
  assert.equal((await provider.invoices("sub_fixture", 0)).length, 0);
  assert.equal(requests, 3);
});
it("does not expose provider response bodies or secrets on API rejection", async (context) => {
  context.mock.method(globalThis, "fetch", async () =>
    Response.json({ private: "should-not-be-exposed" }, { status: 401 }),
  );
  const provider = new RazorpayProvider(environment);
  try {
    await provider.fetchPlan("plan_fixture");
    assert.fail("A rejected provider request must fail.");
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.ok(error instanceof ServiceError);
    assert.equal(error.code, "PROVIDER_AUTHENTICATION_FAILED");
    assert.match(error.message, /HTTP 401/);
    assert.equal(error.message.includes("should-not-be-exposed"), false);
    assert.equal(error.message.includes(secret), false);
  }
});
it("distinguishes missing credentials, mode mismatch, malformed input and blocked live mode without API calls", async (context) => {
  let requests = 0;
  context.mock.method(globalThis, "fetch", async () => {
    requests++;
    throw new Error("No request expected");
  });
  const cases = [
    [{}, "RAZORPAY_CREDENTIALS_MISSING"],
    [
      { ...environment, RAZORPAY_KEY_SECRET: "" },
      "RAZORPAY_CREDENTIALS_MISSING",
    ],
    [
      { ...environment, RAZORPAY_KEY_ID: "rzp_live_fixture" },
      "RAZORPAY_MODE_KEY_MISMATCH",
    ],
    [{ ...environment, RAZORPAY_MODE: "live" }, "RAZORPAY_MODE_KEY_MISMATCH"],
    [{ ...environment, RAZORPAY_MODE: "TEST" }, "RAZORPAY_MODE_INVALID"],
    [
      { ...environment, RAZORPAY_KEY_ID: "merchant_fixture" },
      "RAZORPAY_KEY_FORMAT_INVALID",
    ],
    [
      { ...environment, RAZORPAY_KEY_SECRET: ` ${secret}` },
      "RAZORPAY_CREDENTIAL_FORMAT_INVALID",
    ],
    [
      {
        ...environment,
        RAZORPAY_MODE: "live",
        RAZORPAY_KEY_ID: "rzp_live_fixture",
      },
      "RAZORPAY_LIVE_MODE_BLOCKED",
    ],
  ] as const;
  for (const [env, code] of cases) {
    const provider = new RazorpayProvider(env);
    assert.equal(provider.apiAvailable, false);
    assert.equal(provider.apiConfigurationError?.code, code);
    await assert.rejects(
      provider.fetchPlan("plan_fixture"),
      (e: unknown) =>
        e instanceof ServiceError &&
        e.code === code &&
        !e.message.includes(secret),
    );
  }
  assert.equal(requests, 0);
  assert.equal(new RazorpayProvider(environment).apiConfigurationError, null);
  assert.equal(new RazorpayProvider(environment).apiAvailable, true);
});
it("distinguishes provider permission, missing resource, rate limit and service errors safely", async (context) => {
  let status = 403;
  context.mock.method(globalThis, "fetch", async () =>
    Response.json({ echo: secret }, { status }),
  );
  const cases = [
    [403, "PROVIDER_PERMISSION_DENIED"],
    [404, "PROVIDER_NOT_FOUND"],
    [429, "PROVIDER_RATE_LIMITED"],
    [400, "PROVIDER_REJECTED"],
    [503, "PROVIDER_UNAVAILABLE"],
  ] as const;
  for (const [http, code] of cases) {
    status = http;
    await assert.rejects(
      new RazorpayProvider(environment).fetchPlan("plan_fixture"),
      (e: unknown) =>
        e instanceof ServiceError &&
        e.code === code &&
        e.message.includes(`HTTP ${http}`) &&
        !e.message.includes(secret),
    );
  }
});
it("distinguishes network, timeout and malformed JSON failures without exposing underlying exceptions", async (context) => {
  let failure: "network" | "timeout" | "response" = "network";
  context.mock.method(globalThis, "fetch", async () => {
    if (failure === "network")
      throw new TypeError(`unsafe network details ${secret}`);
    if (failure === "timeout")
      throw new DOMException(
        `unsafe timeout details ${secret}`,
        "TimeoutError",
      );
    return new Response("not json", { status: 200 });
  });
  for (const [type, code] of [
    ["network", "PROVIDER_NETWORK_ERROR"],
    ["timeout", "PROVIDER_TIMEOUT"],
    ["response", "PROVIDER_INVALID_RESPONSE"],
  ] as const) {
    failure = type;
    await assert.rejects(
      new RazorpayProvider(environment).fetchPlan("plan_fixture"),
      (e: unknown) =>
        e instanceof ServiceError &&
        e.code === code &&
        !e.message.includes(secret),
    );
  }
});
