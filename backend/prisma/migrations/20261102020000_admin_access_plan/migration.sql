-- Admin-managed plan assignment is separate from provider subscriptions and payments.
ALTER TABLE `Organization` ADD COLUMN `manualAccessPlan` JSON NULL;
