-- CreateTable
CREATE TABLE `ProviderPlanProvisioning` (
    `reference` CHAR(64) NOT NULL,
    `state` VARCHAR(20) NOT NULL,
    `providerPlanId` VARCHAR(100) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ProviderPlanProvisioning_providerPlanId_key`(`providerPlanId`),
    PRIMARY KEY (`reference`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
