-- Durable baseline for explicitly replacing a subscription superseded by admin policy.
-- Existing subscriptions, payments, prices and trial dates are unchanged.
ALTER TABLE `BillingReplacement` ADD COLUMN `context` JSON NULL;
