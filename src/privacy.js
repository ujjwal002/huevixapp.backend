// Serves the public Privacy Policy page at GET /privacy
// Mounted in app.js OUTSIDE the /api/v1 router, so the URL is
// https://backend.huevix.com/privacy

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Huevix — Privacy Policy</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; max-width: 760px; margin: 0 auto; padding: 32px 20px 64px; color: #1a1a1a; background: #fff; }
  h1 { font-size: 28px; margin-bottom: 4px; }
  h2 { font-size: 19px; margin-top: 32px; }
  .updated { color: #666; font-size: 14px; margin-bottom: 24px; }
  a { color: #2563eb; }
  ul { padding-left: 20px; }
  li { margin: 4px 0; }
  @media (prefers-color-scheme: dark) {
    body { color: #e5e5e5; background: #111; }
    .updated { color: #999; }
  }
</style>
</head>
<body>
  <h1>Privacy Policy</h1>
  <p class="updated">Huevix · Last updated: June 2026</p>

  <p>This Privacy Policy explains how Huevix ("we", "us", or "the app") collects, uses, and protects your information when you use our mobile application and related services. By using Huevix, you agree to the practices described here.</p>

  <h2>Information We Collect</h2>
  <ul>
    <li><strong>Account information:</strong> your email address, a securely hashed password, and your display name.</li>
    <li><strong>Usage and learning data:</strong> your learning progress, lessons viewed, practice activity, and in-app credit balances.</li>
    <li><strong>Purchases:</strong> records of in-app purchases (subscriptions, call credits, and promotions). Payments are processed by Google Play; we do not receive or store your full payment-card details. We store purchase identifiers and entitlement status to deliver what you bought.</li>
    <li><strong>Content you provide:</strong> information you submit for promotions (such as a business name, description, links, and images), and messages or inputs you provide to the in-app AI tutor.</li>
    <li><strong>Practice calls:</strong> if you use audio or video practice calls, we process audio and video to provide the feature, and recordings may be temporarily stored to operate and improve the service.</li>
    <li><strong>Notifications:</strong> a device push token so we can send you notifications.</li>
    <li><strong>Device and technical information:</strong> device type, operating system, app version, IP address, and diagnostic logs.</li>
  </ul>

  <h2>How We Use Your Information</h2>
  <ul>
    <li>To provide, maintain, and improve the app and its features.</li>
    <li>To authenticate you and keep your account secure.</li>
    <li>To process purchases and deliver subscriptions, credits, and promotions.</li>
    <li>To send you notifications related to the service.</li>
    <li>To review user-submitted promotional content.</li>
    <li>To respond to your requests and provide support.</li>
    <li>To comply with legal obligations and enforce our terms.</li>
  </ul>

  <h2>How We Share Information</h2>
  <p>We do not sell your personal information. We share information only with:</p>
  <ul>
    <li><strong>Service providers</strong> who help us operate the app, such as cloud hosting, push-notification delivery, and providers that power AI features. These providers process data on our behalf.</li>
    <li><strong>Google Play</strong>, which processes payments for in-app purchases.</li>
    <li><strong>Legal authorities</strong>, where required by law or to protect our rights, our users, or the public.</li>
  </ul>

  <h2>Data Retention</h2>
  <p>We keep your information for as long as your account is active or as needed to provide the service. You may request deletion of your account and associated personal data at any time (see "Your Rights" below). We may retain certain records where required for legal, security, or accounting purposes.</p>

  <h2>Data Security</h2>
  <p>We use reasonable technical and organizational measures to protect your information, including encryption in transit and hashing of passwords. No method of transmission or storage is completely secure, but we work to protect your data.</p>

  <h2>Your Rights</h2>
  <p>You may request to access, correct, or delete your personal information, or to delete your account. To make a request, contact us at the email below, and we will respond within a reasonable timeframe.</p>

  <h2>Children's Privacy</h2>
  <p>Huevix is not directed to children under the age required by law in their country (at least 13). We do not knowingly collect personal information from such children. If you believe a child has provided us information, please contact us and we will remove it.</p>

  <h2>International Users</h2>
  <p>Your information may be processed and stored in countries other than your own, where data-protection laws may differ. By using the app, you consent to this processing.</p>

  <h2>Changes to This Policy</h2>
  <p>We may update this Privacy Policy from time to time. We will update the "Last updated" date above, and significant changes may be communicated within the app.</p>

  <h2>Contact Us</h2>
  <p>If you have questions about this Privacy Policy or your data, contact us at <a href="mailto:ujjwalsingh208743@gmail.com">ujjwalsingh208743@gmail.com</a>.</p>
</body>
</html>`;

export function servePrivacy(_req, res) {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}
