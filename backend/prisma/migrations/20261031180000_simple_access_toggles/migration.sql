ALTER TABLE `Organization`
  ADD COLUMN `trialEnabled` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `subscriptionEnabled` BOOLEAN NOT NULL DEFAULT false;
