// Serves the public "Delete your account" page at GET /delete-account
// Mounted in app.js OUTSIDE the /api/v1 router, so the URL is
// https://backend.huevix.com/delete-account

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Huevix — Delete Your Account</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; max-width: 760px; margin: 0 auto; padding: 32px 20px 64px; color: #1a1a1a; background: #fff; }
  h1 { font-size: 28px; margin-bottom: 4px; }
  h2 { font-size: 19px; margin-top: 32px; }
  .updated { color: #666; font-size: 14px; margin-bottom: 24px; }
  a { color: #2563eb; }
  ol, ul { padding-left: 20px; }
  li { margin: 6px 0; }
  .box { background: #f3f4f6; border-radius: 8px; padding: 16px 20px; margin: 16px 0; }
  @media (prefers-color-scheme: dark) {
    body { color: #e5e5e5; background: #111; }
    .updated { color: #999; }
    .box { background: #1f2937; }
  }
</style>
</head>
<body>
  <h1>Delete Your Huevix Account</h1>
  <p class="updated">Huevix · Last updated: June 2026</p>

  <p>This page explains how to request deletion of your <strong>Huevix</strong> account and the data associated with it.</p>

  <h2>How to request account deletion</h2>
  <p>You can delete your account in one of two ways:</p>

  <h3>Option 1 — In the app</h3>
  <ol>
    <li>Open the Huevix app and sign in.</li>
    <li>Go to your <strong>Profile</strong>.</li>
    <li>Open <strong>Settings</strong> and choose <strong>Delete account</strong>.</li>
    <li>Confirm the deletion when prompted.</li>
  </ol>

  <h3>Option 2 — By email</h3>
  <div class="box">
    Send an email to <a href="mailto:ujjwalsingh208743@gmail.com">ujjwalsingh208743@gmail.com</a> from the email address registered to your Huevix account, with the subject line <strong>"Delete my account"</strong>. We will verify your request and delete your account within 30 days.
  </div>

  <h2>What data is deleted</h2>
  <p>When your account is deleted, we permanently remove the personal data associated with it, including:</p>
  <ul>
    <li>Your account details (email address, name, and password)</li>
    <li>Your learning progress, practice activity, and in-app credit balances</li>
    <li>Content you submitted, such as promotions and AI tutor inputs</li>
    <li>Your device/push notification tokens</li>
  </ul>

  <h2>What data may be retained</h2>
  <p>We may retain a limited amount of information where required by law or for legitimate business purposes, such as:</p>
  <ul>
    <li>Transaction and purchase records, retained as required for legal, tax, and accounting obligations</li>
    <li>Records needed to detect or prevent fraud, abuse, or security incidents</li>
  </ul>
  <p>Any retained data is kept only as long as required and is then deleted.</p>

  <h2>Contact</h2>
  <p>If you have any questions about deleting your account or your data, contact us at <a href="mailto:ujjwalsingh208743@gmail.com">ujjwalsingh208743@gmail.com</a>.</p>
</body>
</html>`;

export function serveDeleteAccount(_req, res) {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}
