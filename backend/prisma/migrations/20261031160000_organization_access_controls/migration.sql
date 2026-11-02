ALTER TABLE `Organization`
    ADD COLUMN `accessMode` VARCHAR(16) NOT NULL DEFAULT 'AUTO',
    ADD COLUMN `manualAccessStartsAt` DATETIME(3) NULL,
    ADD COLUMN `manualAccessExpiresAt` DATETIME(3) NULL,
    ADD COLUMN `accessVersion` INTEGER NOT NULL DEFAULT 0;

CREATE TABLE `OrganizationAccessAudit` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `organizationName` VARCHAR(191) NOT NULL,
    `actorSuperAdminId` VARCHAR(191) NOT NULL,
    `actorName` VARCHAR(120) NOT NULL,
    `action` VARCHAR(32) NOT NULL,
    `outcome` VARCHAR(16) NOT NULL,
    `reason` VARCHAR(500) NOT NULL,
    `before` JSON NULL,
    `after` JSON NULL,
    `requestId` VARCHAR(64) NOT NULL,
    `requestHash` CHAR(64) NOT NULL,
    `failureCode` VARCHAR(40) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE INDEX `OrganizationAccessAudit_requestId_outcome_key` (`requestId`, `outcome`),
    INDEX `OrganizationAccessAudit_organizationId_createdAt_idx` (`organizationId`, `createdAt`),
    INDEX `OrganizationAccessAudit_actorSuperAdminId_createdAt_idx` (`actorSuperAdminId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
