// Serves the public Terms of Service page at GET /terms
// Mounted in app.js OUTSIDE the /api/v1 router, next to /privacy and
// /delete-account, so the URL is https://backend.huevix.com/terms
//
// NOTE: this is a practical starter template written for how Huevix actually
// works (Play billing, coins, quiz rewards, tutors, promotions, AI features).
// It is not legal advice — have a lawyer review it when revenue justifies it.

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Huevix — Terms of Service</title>
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
  <h1>Terms of Service</h1>
  <p class="updated">Huevix · Last updated: June 2026</p>

  <p>These Terms of Service ("Terms") govern your use of the Huevix mobile application and related services ("the Service"), operated by Huevix ("we", "us"). By creating an account or using the Service, you agree to these Terms and to our <a href="/privacy">Privacy Policy</a>. If you do not agree, do not use the Service.</p>

  <h2>1. Eligibility</h2>
  <p>You must be at least 13 years old (or the minimum age required in your country) to use Huevix. If you are under 18, you confirm that a parent or guardian has reviewed and agreed to these Terms on your behalf. You agree to provide accurate account information and to keep your credentials secure. You are responsible for activity on your account.</p>

  <h2>2. The Service</h2>
  <p>Huevix helps you learn and practice English through lessons, daily vocabulary, quizzes, live audio/video practice calls, AI-assisted tutoring, and related features. We may add, change, or remove features at any time. Some features require an internet connection, a supported device, and permissions such as microphone or camera access.</p>

  <h2>3. Subscriptions and billing</h2>
  <ul>
    <li>Paid subscriptions and in-app purchases are processed by <strong>Google Play</strong>, under Google's payment terms.</li>
    <li>Subscriptions <strong>renew automatically</strong> until cancelled. You can cancel anytime in the Play Store (Play Store → Profile → Payments &amp; subscriptions → Subscriptions); access continues until the end of the paid period.</li>
    <li>Deleting your Huevix account stops future subscription renewals.</li>
    <li>Refunds are handled under Google Play's refund policies and applicable law.</li>
    <li>Prices may change; changes apply from the next billing period and Google notifies you as required.</li>
  </ul>

  <h2>4. Coins and virtual items</h2>
  <p>Coins and similar in-app balances are a limited, revocable, non-transferable licence to use features within Huevix. They are <strong>not money</strong>, have no cash value, cannot be sold or exchanged outside the app, and are forfeited when your account is deleted or terminated for breach. Except where the law requires otherwise, coin purchases are non-refundable once granted.</p>

  <h2>5. Rewarded ads and free credit</h2>
  <p>We may offer free minutes, coins, or other credit for watching ads or completing activities. These offers can change or end at any time, and credit obtained through fraud, automation, or abuse may be removed.</p>

  <h2>6. Quiz and rewards</h2>
  <ul>
    <li>The daily quiz is a skill-based activity. Leaderboard rewards, where offered, are limited to <strong>one account per person</strong>.</li>
    <li>Using multiple accounts, automation, answer-sharing, or other manipulation disqualifies you and may lead to account termination.</li>
    <li>Winners may be asked for contact details (such as a phone number) to arrange the reward. Rewards are non-transferable; we may substitute a reward of equal value; rewards are void where prohibited by law.</li>
  </ul>

  <h2>7. Practice calls and community conduct</h2>
  <ul>
    <li>Practice calls connect you with other real people. Be respectful. Harassment, hate speech, sexual content, threats, spam, and attempts to defraud other users are prohibited.</li>
    <li>Do not share other participants' personal information, and do not record calls except as the Service itself does to operate and improve the feature (see the Privacy Policy).</li>
    <li>We may suspend call access or terminate accounts for misconduct, with or without notice.</li>
  </ul>

  <h2>8. Tutors</h2>
  <p>Users who enable tutor features agree to conduct sessions professionally and lawfully. Tutors are independent users, not our employees. Any tutor earnings or credits are subject to verification and may be withheld or reversed where obtained through fraud, chargebacks, or breach of these Terms.</p>

  <h2>9. Promotions you submit</h2>
  <p>If you purchase an in-app promotion, you must own the rights to the content you submit (names, text, links, images). All promotions are reviewed before going live; we may reject or remove content that is unlawful, misleading, infringing, or inappropriate. If your promotion is rejected in review, contact us — where required, we will refund the promotion fee. You grant us a licence to display your submitted content within the Service for the promotion you purchased.</p>

  <h2>10. AI features</h2>
  <p>Parts of the Service use artificial intelligence (for example, the AI tutor and speech feedback). AI output can be inaccurate or incomplete. It is provided for learning practice only and is not professional advice. Do not rely on it where accuracy matters.</p>

  <h2>11. Acceptable use</h2>
  <p>You agree not to: break the law; infringe others' rights; upload malicious code; probe, scrape, or reverse-engineer the Service; circumvent security, billing, ads, or usage limits; use the Service to send spam; or interfere with other users' use of the Service.</p>

  <h2>12. Your content and our rights</h2>
  <p>You keep ownership of content you submit. You grant us a worldwide, non-exclusive licence to host, process, and display it as needed to operate the Service. Everything else in the Service — the app, brand, design, and learning content — belongs to us or our licensors and may not be copied or reused without permission.</p>

  <h2>13. Termination</h2>
  <p>You may stop using Huevix and delete your account at any time (see <a href="/delete-account">Delete your account</a>). We may suspend or terminate accounts that breach these Terms, abuse other users, or create risk for the Service. Sections that by their nature should survive (including 4, 12, 14, and 15) survive termination.</p>

  <h2>14. Disclaimers</h2>
  <p>The Service is provided "as is" and "as available". To the maximum extent permitted by law, we disclaim all warranties, express or implied, including fitness for a particular purpose and uninterrupted or error-free operation. We do not guarantee any particular learning outcome.</p>

  <h2>15. Limitation of liability</h2>
  <p>To the maximum extent permitted by law, we are not liable for indirect, incidental, special, or consequential damages, or loss of data or profits, arising from your use of the Service. Our total liability for any claim is limited to the amount you paid us in the 12 months before the claim, or ₹1,000, whichever is greater. Nothing in these Terms limits liability that cannot be limited under applicable law.</p>

  <h2>16. Changes to these Terms</h2>
  <p>We may update these Terms from time to time. We will update the "Last updated" date above, and significant changes may be communicated within the app. Continued use after changes take effect means you accept them.</p>

  <h2>17. Governing law</h2>
  <p>These Terms are governed by the laws of India. Courts located in India will have jurisdiction over disputes, subject to any mandatory consumer-protection rights in your place of residence.</p>

  <h2>18. Contact</h2>
  <p>Questions about these Terms: <a href="mailto:ujjwalsingh208743@gmail.com">ujjwalsingh208743@gmail.com</a>.</p>
</body>
</html>`;

export function serveTerms(_req, res) {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}