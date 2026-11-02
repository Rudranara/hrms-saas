-- Additive only. Preserve all historical timestamps, prices, terms and trial dates.
ALTER TABLE `Subscription` ADD COLUMN `creationOperationId` VARCHAR(64) NULL;
CREATE UNIQUE INDEX `Subscription_creationOperationId_key` ON `Subscription`(`creationOperationId`);
ALTER TABLE `BillingPayment`
  ADD COLUMN `paymentCreatedAt` DATETIME(3) NULL,
  ADD COLUMN `captureVerifiedAt` DATETIME(3) NULL,
  ADD COLUMN `paidAtSource` VARCHAR(32) NULL,
  ADD COLUMN `amountRefundedMinor` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
CREATE TABLE `BillingReplacement` (
  `id` VARCHAR(191) NOT NULL, `organizationId` VARCHAR(191) NOT NULL,
  `fromSubscriptionId` VARCHAR(191) NOT NULL, `toSubscriptionId` VARCHAR(191) NULL,
  `quoteId` VARCHAR(191) NOT NULL, `state` VARCHAR(20) NOT NULL,
  `settleAfter` DATETIME(3) NULL, `reason` VARCHAR(100) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`), UNIQUE INDEX `BillingReplacement_fromSubscriptionId_key` (`fromSubscriptionId`),
  UNIQUE INDEX `BillingReplacement_toSubscriptionId_key` (`toSubscriptionId`),
  INDEX `BillingReplacement_organizationId_state_idx` (`organizationId`, `state`),
  INDEX `BillingReplacement_state_updatedAt_idx` (`state`, `updatedAt`),
  CONSTRAINT `BillingReplacement_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
