// Prices are the final recurring charge: never add an implicit percentage or
// addon. GST breakdown/invoicing must be configured with the merchant/provider.
export function billingTaxNote(env: NodeJS.ProcessEnv = process.env) {
  const treatment = env.BILLING_TAX_TREATMENT || "inclusive";
  if (treatment === "inclusive")
    return "Prices include GST where applicable. No additional taxes or fees are added by HRMS.";
  if (treatment === "not_applicable")
    return "GST is not applicable under the configured merchant policy. No additional taxes or fees are added by HRMS.";
  throw new Error(
    "Unsupported BILLING_TAX_TREATMENT. Configure inclusive or not_applicable; additive tax collection is not implemented.",
  );
}
