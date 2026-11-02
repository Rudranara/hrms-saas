-- CreateTable
CREATE TABLE `RefundRequest` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `organizationName` VARCHAR(191) NOT NULL,
    `paymentId` VARCHAR(191) NOT NULL,
    `activePaymentId` VARCHAR(191) NULL,
    `requestedBy` VARCHAR(191) NOT NULL,
    `submissionKey` CHAR(36) NOT NULL,
    `reason` VARCHAR(1000) NOT NULL,
    `status` VARCHAR(24) NOT NULL DEFAULT 'PENDING',
    `requestedAmountMinor` INTEGER NOT NULL,
    `approvedAmountMinor` INTEGER NULL,
    `decisionKey` CHAR(36) NULL,
    `decisionBy` VARCHAR(191) NULL,
    `decisionName` VARCHAR(191) NULL,
    `rejectionReason` VARCHAR(1000) NULL,
    `decidedAt` DATETIME(3) NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `RefundRequest_activePaymentId_key`(`activePaymentId`),
    UNIQUE INDEX `RefundRequest_submissionKey_key`(`submissionKey`),
    UNIQUE INDEX `RefundRequest_decisionKey_key`(`decisionKey`),
    INDEX `RefundRequest_organizationId_createdAt_idx`(`organizationId`, `createdAt`),
    INDEX `RefundRequest_status_createdAt_idx`(`status`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RefundTransaction` (
    `id` VARCHAR(191) NOT NULL,
    `requestId` VARCHAR(191) NULL,
    `paymentId` VARCHAR(191) NOT NULL,
    `providerRefundId` VARCHAR(100) NULL,
    `receipt` VARCHAR(40) NOT NULL,
    `idempotencyKey` VARCHAR(64) NOT NULL,
    `amountMinor` INTEGER NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `status` VARCHAR(24) NOT NULL DEFAULT 'PREPARED',
    `providerStatus` VARCHAR(24) NULL,
    `failureCode` VARCHAR(80) NULL,
    `providerCreatedAt` DATETIME(3) NULL,
    `verifiedAt` DATETIME(3) NULL,
    `processedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `RefundTransaction_requestId_key`(`requestId`),
    UNIQUE INDEX `RefundTransaction_providerRefundId_key`(`providerRefundId`),
    UNIQUE INDEX `RefundTransaction_receipt_key`(`receipt`),
    UNIQUE INDEX `RefundTransaction_idempotencyKey_key`(`idempotencyKey`),
    INDEX `RefundTransaction_status_updatedAt_idx`(`status`, `updatedAt`),
    INDEX `RefundTransaction_paymentId_createdAt_idx`(`paymentId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RefundAuditEvent` (
    `id` VARCHAR(191) NOT NULL,
    `requestId` VARCHAR(191) NOT NULL,
    `actorId` VARCHAR(191) NULL,
    `actorName` VARCHAR(191) NULL,
    `action` VARCHAR(40) NOT NULL,
    `amountMinor` INTEGER NULL,
    `detail` VARCHAR(1000) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `RefundAuditEvent_requestId_createdAt_idx`(`requestId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `RefundRequest` ADD CONSTRAINT `RefundRequest_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `BillingPayment`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RefundTransaction` ADD CONSTRAINT `RefundTransaction_requestId_fkey` FOREIGN KEY (`requestId`) REFERENCES `RefundRequest`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RefundTransaction` ADD CONSTRAINT `RefundTransaction_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `BillingPayment`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RefundAuditEvent` ADD CONSTRAINT `RefundAuditEvent_requestId_fkey` FOREIGN KEY (`requestId`) REFERENCES `RefundRequest`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;