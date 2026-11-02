-- Add a platform-only role without changing any existing user's role or data.
ALTER TABLE `User` MODIFY `role` ENUM('ORGANIZATION_ADMIN', 'EMPLOYEE', 'SUPER_ADMIN') NOT NULL DEFAULT 'EMPLOYEE';
