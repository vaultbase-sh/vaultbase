/**
 * Default email templates, as the server sends them when a template setting
 * is empty. Kept equal to DEFAULT_TEMPLATES in src/core/email.ts; a test
 * (email-templates.test.ts) fails if they drift apart.
 */
export const DEFAULT_EMAIL_TEMPLATES = {
  verify: {
    subject: "Verify your email",
    body:
      "Hi,\n\n" +
      "Click the link below to verify your email address for {{appUrl}}:\n\n" +
      "{{link}}\n\n" +
      "This link expires in 1 hour. If you didn't request this, you can ignore this email.\n",
  },
  reset: {
    subject: "Reset your password",
    body:
      "Hi,\n\n" +
      "We received a request to reset the password for your {{appUrl}} account.\n" +
      "Click the link below to choose a new password:\n\n" +
      "{{link}}\n\n" +
      "This link expires in 1 hour. If you didn't request this, you can ignore this email.\n",
  },
  email_change: {
    subject: "Confirm your new email address",
    body:
      "Hi,\n\n" +
      "You asked to change the email address of your {{appUrl}} account to {{email}}.\n" +
      "Click the link below to confirm:\n\n" +
      "{{link}}\n\n" +
      "This link expires in 1 hour. If you didn't request this, you can ignore this email.\n",
  },
  invite: {
    subject: "You're invited",
    body:
      "Hi,\n\n" +
      "You've been invited to {{appUrl}}. Click the link below to choose a password and finish setting up your account:\n\n" +
      "{{link}}\n\n" +
      "This link expires in 7 days.\n",
  },
  otp: {
    subject: "Your sign-in code",
    body:
      "Hi,\n\n" +
      "Use this code to sign in to {{appUrl}}:\n\n" +
      "    {{code}}\n\n" +
      "Or click the link below:\n\n" +
      "{{link}}\n\n" +
      "Both expire in 10 minutes. If you didn't request this, you can ignore this email.\n",
  },
} as const;

export type EmailTemplateKind = keyof typeof DEFAULT_EMAIL_TEMPLATES;
