CREATE TABLE `PendingRegistration` (
 `id` VARCHAR(191) NOT NULL,
 `tokenHash` CHAR(64) NOT NULL,
 `organizationName` VARCHAR(120) NOT NULL,
 `fullName` VARCHAR(120) NOT NULL,
 `email` VARCHAR(254) NOT NULL,
 `passwordHash` VARCHAR(255) NOT NULL,
 `codeHash` CHAR(64) NOT NULL,
 `failedAttempts` INTEGER NOT NULL DEFAULT 0,
 `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 `sentAt` DATETIME(3) NOT NULL,
 `expiresAt` DATETIME(3) NOT NULL,
 UNIQUE INDEX `PendingRegistration_tokenHash_key` (`tokenHash`),
 INDEX `PendingRegistration_email_createdAt_idx` (`email`, `createdAt`),
 INDEX `PendingRegistration_expiresAt_idx` (`expiresAt`),
 PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
