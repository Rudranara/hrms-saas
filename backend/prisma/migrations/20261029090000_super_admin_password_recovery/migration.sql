-- Platform password recovery remains independent from organization AccountToken.
CREATE TABLE `SuperAdminPasswordReset` (
    `id` VARCHAR(191) NOT NULL,
    `superAdminId` VARCHAR(191) NOT NULL,
    `tokenHash` CHAR(64) NOT NULL,
    `authVersion` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,
    `consumedAt` DATETIME(3) NULL,

    UNIQUE INDEX `SuperAdminPasswordReset_superAdminId_key`(`superAdminId`),
    UNIQUE INDEX `SuperAdminPasswordReset_tokenHash_key`(`tokenHash`),
    INDEX `SuperAdminPasswordReset_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `SuperAdminPasswordReset` ADD CONSTRAINT `SuperAdminPasswordReset_superAdminId_fkey` FOREIGN KEY (`superAdminId`) REFERENCES `SuperAdmin`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
