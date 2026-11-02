import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { billingHref, billingReturn, selectedBillingPlan } from "../../frontend/app/lib/billing-continuation";
import type { BillingPlan } from "../../frontend/app/lib/billing-types";

const plans: BillingPlan[] = JSON.parse(readFileSync("config/billing-plans.json", "utf8"));
for (const plan of plans) {
  it(`preserves ${plan.id} and its explicit period through safe auth and registration URLs`, () => {
    const destination = billingHref(plan);
    const login = `/login?${new URLSearchParams({ next: destination })}`;
    const returned = new URL(login, "http://localhost").searchParams.get("next");
    assert.equal(billingReturn(returned), destination);
    assert.equal(selectedBillingPlan(returned, plans)?.id, plan.id);
    assert.equal(selectedBillingPlan(billingHref(plan, true), plans)?.interval, plan.interval);
    assert.ok(billingHref(plan, true).endsWith("review=1"));
    assert.equal(selectedBillingPlan(`/billing?plan=${plan.id}`, plans)?.id, plan.id);
  });
}
it("rejects external redirects, malformed queries, duplicate parameters and tampered periods", () => {
  for (const value of [null, "https://evil.test/billing?plan=growth-monthly", "//evil.test", "/\\evil.test", "/dashboard", "/billing?plan=x#fragment", "/billing?plan=x&next=https://evil.test", "/billing?plan=x&plan=y", "/billing?plan=growth-monthly&period=weekly", "/billing?plan=growth-monthly&period=monthly&period=yearly", "/billing?plan=growth-monthly&review=0", "/billing?plan=%0afoo", "/billing?plan=..%2Ffoo"]) {
    assert.equal(billingReturn(value), null, String(value));
  }
  assert.equal(selectedBillingPlan("/billing?plan=unknown-monthly", plans), null);
  assert.equal(selectedBillingPlan("/billing?plan=growth-monthly&period=yearly", plans), null);
  assert.equal(selectedBillingPlan("/billing?plan=growth-yearly&period=monthly", plans), null);
});
