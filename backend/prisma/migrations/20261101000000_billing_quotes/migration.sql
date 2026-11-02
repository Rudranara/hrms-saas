ALTER TABLE `Subscription` ADD COLUMN `commercialTerms` JSON NULL;
CREATE TABLE `BillingQuote` (
 `id` VARCHAR(191) NOT NULL, `organizationId` VARCHAR(191) NOT NULL,
 `organizationName` VARCHAR(191) NOT NULL, `planId` VARCHAR(80) NOT NULL,
 `planName` VARCHAR(80) NOT NULL, `providerPlanId` VARCHAR(100) NOT NULL,
 `interval` ENUM('MONTHLY', 'YEARLY') NOT NULL,
 `amountMinor` INTEGER NOT NULL, `currency` CHAR(3) NOT NULL,
 `totalCount` INTEGER NOT NULL, `taxNote` VARCHAR(500) NOT NULL,
 `version` INTEGER NOT NULL DEFAULT 1, `subscriptionId` VARCHAR(191) NULL,
 `expiresAt` DATETIME(3) NOT NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 PRIMARY KEY (`id`), INDEX `BillingQuote_organizationId_createdAt_idx` (`organizationId`, `createdAt`),
 INDEX `BillingQuote_expiresAt_idx` (`expiresAt`),
 CONSTRAINT `BillingQuote_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
