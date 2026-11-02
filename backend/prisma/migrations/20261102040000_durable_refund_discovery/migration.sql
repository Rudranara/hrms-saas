CREATE TABLE `RefundDiscoveryScan` (
  `id` VARCHAR(40) NOT NULL,
  `cursor` VARCHAR(191) NULL,
  `upperBound` VARCHAR(191) NULL,
  `leaseOwner` CHAR(36) NULL,
  `leaseUntil` DATETIME(3) NULL,
  `pausedUntil` DATETIME(3) NULL,
  `rateLimitAttempts` INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `RefundDiscoveryRetry` (
  `paymentId` VARCHAR(191) NOT NULL,
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `nextAttemptAt` DATETIME(3) NOT NULL,
  `failureCode` VARCHAR(80) NOT NULL,
  PRIMARY KEY (`paymentId`),
  INDEX `RefundDiscoveryRetry_nextAttemptAt_paymentId_idx` (`nextAttemptAt`, `paymentId`),
  CONSTRAINT `RefundDiscoveryRetry_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `BillingPayment` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
