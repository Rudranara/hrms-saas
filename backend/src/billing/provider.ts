import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ServiceError } from "../services/errors";

const id = z
  .string()
  .regex(/^[A-Za-z0-9_]+$/)
  .max(100);
const subscriptionSchema = z.object({
  id,
  plan_id: id,
  status: z.enum([
    "created",
    "authenticated",
    "active",
    "pending",
    "halted",
    "cancelled",
    "completed",
    "expired",
    "paused",
  ]),
  customer_id: z.string().nullable().optional(),
  current_start: z.number().int().nullable(),
  current_end: z.number().int().nullable(),
  charge_at: z.number().int().nullable().optional(),
  paid_count: z.number().int().nonnegative(),
  has_scheduled_changes: z.boolean().optional(),
  ended_at: z.number().int().nullable().optional(),
  notes: z.record(z.string(), z.string()).default({}),
});
const planSchema = z.object({
  id,
  period: z.enum(["monthly", "yearly"]),
  interval: z.number().int(),
  item: z.object({ amount: z.number().int().positive(), currency: z.string() }),
  notes: z
    .union([z.record(z.string(), z.string()), z.array(z.never())])
    .optional(),
});
const invoiceSchema = z.object({
  id,
  subscription_id: z.string().nullable().optional(),
  payment_id: z.string().nullable(),
  status: z.string(),
  currency: z.string(),
  amount_paid: z.number().int(),
  billing_start: z.number().int().nullable().optional(),
  billing_end: z.number().int().nullable().optional(),
  issued_at: z.number().int().nullable().optional(),
  created_at: z.number().int(),
});
const paymentSchema = z.object({
  id,
  invoice_id: z.string().nullable(),
  status: z.string(),
  amount: z.number().int(),
  currency: z.string(),
  amount_refunded: z.number().int().default(0),
  created_at: z.number().int(),
});
export type RemoteSubscription = z.infer<typeof subscriptionSchema>;
export type RemotePlan = z.infer<typeof planSchema>;
export type RemoteInvoice = z.infer<typeof invoiceSchema>;
export type RemotePayment = z.infer<typeof paymentSchema>;
export interface PaymentProvider {
  apiConfigurationError?: ServiceError | null;
  available: boolean;
  keyId: string;
  mode: "test" | "live";
  fetchPlan(planId: string): Promise<RemotePlan>;
  createSubscription(
    planId: string,
    cycles: number,
    reference: string,
    organizationId: string,
  ): Promise<RemoteSubscription>;
  fetchSubscription(subscriptionId: string): Promise<RemoteSubscription>;
  findSubscription(
    reference: string,
    since: Date,
  ): Promise<RemoteSubscription | null>;
  invoices(subscriptionId: string, from: number): Promise<RemoteInvoice[]>;
  invoice(invoiceId: string): Promise<RemoteInvoice>;
  payment(paymentId: string): Promise<RemotePayment>;
  cancel(
    subscriptionId: string,
    atCycleEnd: boolean,
  ): Promise<RemoteSubscription>;
  verifyCheckout(
    paymentId: string,
    subscriptionId: string,
    signature: string,
  ): boolean;
  verifyWebhook(body: Buffer, signature: string): boolean;
}
export function validSignature(
  value: string | Buffer,
  signature: string,
  secret: string,
) {
  if (!secret || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(value).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}
export function definiteProviderRejection(error: unknown) {
  return (
    error instanceof ServiceError &&
    [
      "PROVIDER_REJECTED",
      "PROVIDER_AUTHENTICATION_FAILED",
      "PROVIDER_PERMISSION_DENIED",
      "PROVIDER_NOT_FOUND",
    ].includes(error.code)
  );
}
export class RazorpayProvider implements PaymentProvider {
  public readonly apiConfigurationError: ServiceError | null;
  public apiAvailable: boolean;
  public available: boolean;
  public keyId: string;
  public mode: "test" | "live";
  private secret: string;
  private webhookSecret: string;
  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.keyId = env.RAZORPAY_KEY_ID || "";
    this.secret = env.RAZORPAY_KEY_SECRET || "";
    this.webhookSecret = env.RAZORPAY_WEBHOOK_SECRET || "";
    this.mode = env.RAZORPAY_MODE === "live" ? "live" : "test";
    this.apiConfigurationError = this.checkConfiguration(env);
    // Ready to request authentication; only Razorpay can confirm the key pair.
    this.apiAvailable = this.apiConfigurationError === null;
    this.available = this.apiAvailable && !!this.webhookSecret;
  }
  private checkConfiguration(env: NodeJS.ProcessEnv): ServiceError | null {
    if (env.RAZORPAY_MODE && !["test", "live"].includes(env.RAZORPAY_MODE))
      return new ServiceError(
        "RAZORPAY_MODE_INVALID",
        503,
        "RAZORPAY_MODE must be exactly test or live. Check backend environment configuration.",
      );
    if (!this.keyId.trim() || !this.secret.trim())
      return new ServiceError(
        "RAZORPAY_CREDENTIALS_MISSING",
        503,
        "Set both RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in backend/.env or the backend process environment. Local pricing remains available.",
      );
    if (this.keyId !== this.keyId.trim() || this.secret !== this.secret.trim())
      return new ServiceError(
        "RAZORPAY_CREDENTIAL_FORMAT_INVALID",
        503,
        "Razorpay API credentials contain surrounding whitespace. Copy the matching key pair again without spaces; values have not been logged.",
      );
    if (this.mode === "test" && this.keyId.startsWith("rzp_live_"))
      return new ServiceError(
        "RAZORPAY_MODE_KEY_MISMATCH",
        503,
        "RAZORPAY_MODE=test but RAZORPAY_KEY_ID is a Live Mode key. Supply a matching Test Mode key ID and secret from Razorpay. Do not rename the key prefix or switch to live mode to bypass this check.",
      );
    if (this.mode === "live" && this.keyId.startsWith("rzp_test_"))
      return new ServiceError(
        "RAZORPAY_MODE_KEY_MISMATCH",
        503,
        "RAZORPAY_MODE=live but RAZORPAY_KEY_ID is a Test Mode key. Use a matching key pair for the intended mode; development should use test mode.",
      );
    if (!/^rzp_(test|live)_[A-Za-z0-9]+$/.test(this.keyId))
      return new ServiceError(
        "RAZORPAY_KEY_FORMAT_INVALID",
        503,
        "RAZORPAY_KEY_ID is not a supported Razorpay key ID. Copy the API key ID from the intended Razorpay mode, not a merchant ID, plan ID or webhook secret.",
      );
    if (this.mode === "live" && env.NODE_ENV !== "production")
      return new ServiceError(
        "RAZORPAY_LIVE_MODE_BLOCKED",
        503,
        "Live Mode requires NODE_ENV=production. Use Test Mode credentials for local development.",
      );
    return null;
  }
  private async request(
    path: string,
    method = "GET",
    data?: unknown,
  ): Promise<unknown> {
    if (this.apiConfigurationError) throw this.apiConfigurationError;
    try {
      const result = await fetch(`https://api.razorpay.com/v1${path}`, {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.keyId}:${this.secret}`).toString("base64")}`,
          "Content-Type": "application/json",
        },
        body: data === undefined ? undefined : JSON.stringify(data),
        signal: AbortSignal.timeout(8000),
        redirect: "error",
      });
      if (!result.ok) {
        // Never log response bodies, which may echo submitted data.
        if (result.status === 401)
          throw new ServiceError(
            "PROVIDER_AUTHENTICATION_FAILED",
            503,
            "Razorpay rejected API authentication (HTTP 401). Check that the key ID and secret are a matching, active pair from the same account and mode; replace revoked or incorrect credentials.",
          );
        if (result.status === 403)
          throw new ServiceError(
            "PROVIDER_PERMISSION_DENIED",
            503,
            "Razorpay denied this API operation (HTTP 403). Check account access and Subscriptions activation in the selected mode.",
          );
        if (result.status === 404)
          throw new ServiceError(
            "PROVIDER_NOT_FOUND",
            422,
            "Razorpay could not find the requested resource (HTTP 404). Check stored provider plan IDs belong to this account and mode; no replacement plan was created automatically.",
          );
        if (result.status === 429)
          throw new ServiceError(
            "PROVIDER_RATE_LIMITED",
            503,
            "Razorpay rate limit reached (HTTP 429). Wait before retrying synchronization; do not clear provisioning checkpoints.",
          );
        throw new ServiceError(
          result.status >= 500 ? "PROVIDER_UNAVAILABLE" : "PROVIDER_REJECTED",
          result.status >= 500 ? 503 : 422,
          result.status >= 500
            ? `Razorpay API is unavailable (HTTP ${result.status}). Retry later; uncertain creation checkpoints are retained.`
            : `Razorpay rejected the API request (HTTP ${result.status}). Check the configured amount, currency, billing interval and account Subscriptions capabilities. Provider response content has been withheld.`,
        );
      }
      try {
        return await result.json();
      } catch {
        throw new ServiceError(
          "PROVIDER_INVALID_RESPONSE",
          503,
          "Razorpay returned an unreadable API response. Synchronization was not confirmed; retry reconciliation without clearing checkpoints.",
        );
      }
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      const timedOut =
        error instanceof Error &&
        ["TimeoutError", "AbortError"].includes(error.name);
      throw new ServiceError(
        timedOut ? "PROVIDER_TIMEOUT" : "PROVIDER_NETWORK_ERROR",
        503,
        timedOut
          ? "Razorpay API request timed out. Its outcome is unconfirmed; retry reconciliation without clearing checkpoints."
          : "Could not connect to the Razorpay API. Check DNS, internet access, proxy/firewall and TLS connectivity. No provider synchronization was confirmed.",
      );
    }
  }
  private safeId(value: string) {
    return id.parse(value);
  }
  async fetchPlan(value: string) {
    return planSchema.parse(await this.request(`/plans/${this.safeId(value)}`));
  }
  async findPlan(reference: string) {
    let found: RemotePlan | null = null;
    for (let page = 0; page < 100; page++) {
      const { items } = z
        .object({ items: z.array(planSchema) })
        .parse(await this.request(`/plans?count=100&skip=${page * 100}`));
      for (const plan of items) {
        if (
          plan.notes &&
          !Array.isArray(plan.notes) &&
          plan.notes.hrmsPlanReference === reference
        ) {
          if (found && found.id !== plan.id)
            throw new ServiceError(
              "PLAN_RECONCILIATION_REQUIRED",
              503,
              "Multiple matching provider plans require operator review.",
            );
          found = plan;
        }
      }
      if (items.length < 100) return found;
    }
    throw new ServiceError(
      "PLAN_RECONCILIATION_REQUIRED",
      503,
      "Provider plan history requires operator review before creating a plan.",
    );
  }
  async createPlan(
    plan: {
      name: string;
      interval: "MONTHLY" | "YEARLY";
      amountMinor: number;
      currency: string;
    },
    reference: string,
  ) {
    return planSchema.parse(
      await this.request("/plans", "POST", {
        period: plan.interval.toLowerCase(),
        interval: 1,
        item: {
          name: `HRMS ${plan.name} ${plan.interval.toLowerCase()}`,
          amount: plan.amountMinor,
          currency: plan.currency,
        },
        notes: { hrmsPlanReference: reference },
      }),
    );
  }
  async createSubscription(
    planId: string,
    cycles: number,
    reference: string,
    organizationId: string,
  ) {
    return subscriptionSchema.parse(
      await this.request("/subscriptions", "POST", {
        plan_id: planId,
        total_count: cycles,
        quantity: 1,
        customer_notify: true,
        notes: { localSubscriptionId: reference, organizationId },
      }),
    );
  }
  async fetchSubscription(value: string) {
    return subscriptionSchema.parse(
      await this.request(`/subscriptions/${this.safeId(value)}`),
    );
  }
  async findSubscription(reference: string, since: Date) {
    for (let page = 0; page < 10; page++) {
      const result = z
        .object({ items: z.array(subscriptionSchema) })
        .parse(
          await this.request(
            `/subscriptions?from=${Math.floor(since.getTime() / 1000) - 60}&count=100&skip=${page * 100}`,
          ),
        );
      const found = result.items.find(
        (item) => item.notes.localSubscriptionId === reference,
      );
      if (found) return found;
      if (result.items.length < 100) return null;
    }
    throw new ServiceError(
      "RECONCILIATION_REQUIRED",
      503,
      "Provider history requires manual reconciliation. Please contact your administrator.",
    );
  }
  async invoices(subscriptionId: string, _from: number) {
    const invoices: RemoteInvoice[] = [];
    for (let page = 0; page < 100; page++) {
      const result = z.object({ items: z.array(invoiceSchema) }).parse(await this.request(`/invoices?subscription_id=${this.safeId(subscriptionId)}&count=100&skip=${page * 100}`));
      invoices.push(...result.items);
      if (result.items.length < 100) return invoices;
    }
    throw new ServiceError("RECONCILIATION_REQUIRED", 503, "Invoice history exceeds the safe reconciliation limit. Operator review is required.");
  }
  async payment(value: string) {
    return paymentSchema.parse(
      await this.request(`/payments/${this.safeId(value)}`),
    );
  }
  async invoice(value: string) {
    return invoiceSchema.parse(
      await this.request(`/invoices/${this.safeId(value)}`),
    );
  }
  async cancel(value: string, atCycleEnd: boolean) {
    return subscriptionSchema.parse(
      await this.request(
        `/subscriptions/${this.safeId(value)}/cancel`,
        "POST",
        { cancel_at_cycle_end: atCycleEnd ? 1 : 0 },
      ),
    );
  }
  verifyCheckout(paymentId: string, subscriptionId: string, signature: string) {
    return validSignature(
      `${paymentId}|${subscriptionId}`,
      signature,
      this.secret,
    );
  }
  verifyWebhook(body: Buffer, signature: string) {
    return (
      this.available && validSignature(body, signature, this.webhookSecret)
    );
  }
}
