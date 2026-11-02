-- Additive account settings state. No existing user, trial or billing values change.
CREATE TABLE `AdminEmailChange` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `newEmail` VARCHAR(254) NOT NULL,
    `tokenHash` CHAR(64) NOT NULL,
    `authVersion` INTEGER NOT NULL,
    `state` VARCHAR(24) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,
    `consumedAt` DATETIME(3) NULL,
    UNIQUE INDEX `AdminEmailChange_userId_key`(`userId`),
    UNIQUE INDEX `AdminEmailChange_tokenHash_key`(`tokenHash`),
    INDEX `AdminEmailChange_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE `AdminEmailChange` ADD CONSTRAINT `AdminEmailChange_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE `AdminAuditEvent` (
    `id` VARCHAR(191) NOT NULL,
    `actorUserId` VARCHAR(191) NOT NULL,
    `action` VARCHAR(40) NOT NULL,
    `outcome` VARCHAR(16) NOT NULL,
    `reasonCode` VARCHAR(40) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX `AdminAuditEvent_actorUserId_createdAt_idx`(`actorUserId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
