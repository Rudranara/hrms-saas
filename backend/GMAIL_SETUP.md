# Gmail for organisation and super-admin OTPs

Both recovery flows already use the same backend mail service. Set
`MAIL_PROVIDER=gmail` to use Gmail for both. This also applies to verification
and account-change emails sent through that service.

1. Choose a Google account that will send the application's emails.
2. Turn on 2-Step Verification for that account.
3. Create an App Password at https://myaccount.google.com/apppasswords.
4. Fill in these settings in `backend/.env` locally:

   ```dotenv
   MAIL_PROVIDER=gmail
   SMTP_USER=your-sender@gmail.com
   SMTP_PASSWORD=your-16-character-app-password
   ```

   Replace the example values. Do not use your normal Google password. Do not
   paste the App Password into chat, frontend settings, or source control.
   Spaces in Google's displayed App Password are handled automatically.

5. Restart the backend and run `npm.cmd run mail:check` from `backend`.
6. Request a code from `/forgot-password` for an organisation account and from
   `/super-admin/forgot-password` for a platform account. Each recipient must be
   registered in its respective account table. Recipients do not need Gmail accounts.

Gmail mode selects `smtp.gmail.com:465`, requires TLS, and sends from SMTP_USER.
Old SMTP_FROM and Resend settings are ignored in this mode. No domain verification
in Resend is needed. SMTP authentication checks do not send mail; verify delivery
using the actual recovery forms.

Google may not offer App Passwords for some managed accounts, Advanced Protection,
or accounts using security-key-only 2-Step Verification. See Google's instructions:
https://support.google.com/accounts/answer/185833
