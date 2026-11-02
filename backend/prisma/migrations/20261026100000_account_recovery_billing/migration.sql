-- AlterTable
ALTER TABLE `session` ADD COLUMN `authVersion` INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `user` ADD COLUMN `authVersion` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `emailVerifiedAt` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `AccountToken` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `purpose` ENUM('VERIFY_EMAIL', 'RESET_PASSWORD') NOT NULL,
    `tokenHash` CHAR(64) NOT NULL,
    `authVersion` INTEGER NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `consumedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `AccountToken_tokenHash_key`(`tokenHash`),
    INDEX `AccountToken_expiresAt_idx`(`expiresAt`),
    UNIQUE INDEX `AccountToken_userId_purpose_key`(`userId`, `purpose`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `BillingPlan` (
    `id` VARCHAR(80) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `interval` ENUM('MONTHLY', 'YEARLY') NOT NULL,
    `amountMinor` INTEGER NULL,
    `currency` CHAR(3) NOT NULL DEFAULT 'INR',
    `providerPlanId` VARCHAR(100) NULL,
    `totalCount` INTEGER NOT NULL DEFAULT 12,
    `enabled` BOOLEAN NOT NULL DEFAULT true,

    UNIQUE INDEX `BillingPlan_providerPlanId_key`(`providerPlanId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Subscription` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `planId` VARCHAR(80) NOT NULL,
    `providerSubscriptionId` VARCHAR(100) NULL,
    `providerPlanId` VARCHAR(100) NOT NULL,
    `providerCustomerId` VARCHAR(100) NULL,
    `status` VARCHAR(30) NOT NULL DEFAULT 'CREATING',
    `amountMinor` INTEGER NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `interval` ENUM('MONTHLY', 'YEARLY') NOT NULL,
    `totalCount` INTEGER NOT NULL,
    `paidUntil` DATETIME(3) NULL,
    `currentPeriodStart` DATETIME(3) NULL,
    `currentPeriodEnd` DATETIME(3) NULL,
    `nextBillingAt` DATETIME(3) NULL,
    `cancelAtCycleEnd` BOOLEAN NOT NULL DEFAULT false,
    `cancelledAt` DATETIME(3) NULL,
    `lastSyncedAt` DATETIME(3) NULL,
    `syncLeaseOwner` VARCHAR(64) NULL,
    `syncLeaseUntil` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Subscription_providerSubscriptionId_key`(`providerSubscriptionId`),
    INDEX `Subscription_organizationId_createdAt_idx`(`organizationId`, `createdAt`),
    INDEX `Subscription_providerCustomerId_idx`(`providerCustomerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `BillingPayment` (
    `id` VARCHAR(191) NOT NULL,
    `subscriptionId` VARCHAR(191) NOT NULL,
    `providerPaymentId` VARCHAR(100) NOT NULL,
    `providerInvoiceId` VARCHAR(100) NULL,
    `amountMinor` INTEGER NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `status` VARCHAR(30) NOT NULL,
    `paidAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `BillingPayment_providerPaymentId_key`(`providerPaymentId`),
    INDEX `BillingPayment_subscriptionId_createdAt_idx`(`subscriptionId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `BillingEvent` (
    `id` VARCHAR(128) NOT NULL,
    `subscriptionId` VARCHAR(191) NOT NULL,
    `bodyHash` CHAR(64) NOT NULL,
    `type` VARCHAR(80) NOT NULL,
    `processedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `BillingEvent_subscriptionId_idx`(`subscriptionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AccountToken` ADD CONSTRAINT `AccountToken_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Subscription` ADD CONSTRAINT `Subscription_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Subscription` ADD CONSTRAINT `Subscription_planId_fkey` FOREIGN KEY (`planId`) REFERENCES `BillingPlan`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BillingPayment` ADD CONSTRAINT `BillingPayment_subscriptionId_fkey` FOREIGN KEY (`subscriptionId`) REFERENCES `Subscription`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BillingEvent` ADD CONSTRAINT `BillingEvent_subscriptionId_fkey` FOREIGN KEY (`subscriptionId`) REFERENCES `Subscription`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

