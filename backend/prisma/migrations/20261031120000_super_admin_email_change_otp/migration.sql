-- Keep existing email requests intact; only new OTP requests can be confirmed.
ALTER TABLE `SuperAdminEmailChange`
    ADD COLUMN `otpRequestId` CHAR(64) NULL,
    ADD COLUMN `failedAttempts` INTEGER NOT NULL DEFAULT 0;
