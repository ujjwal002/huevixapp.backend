import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  if (await prisma.sponsoredCard.count() > 0) { console.log('Already has sponsored cards'); return; }
  await prisma.sponsoredCard.create({
    data: {
      advertiser: 'Huevix Premium',
      title: 'Speak English with confidence',
      body: 'Unlock unlimited speaking practice and personalised pronunciation feedback.',
      ctaText: 'Go Premium',
      ctaUrl: '/checkout?plan=MONTHLY', // a "/" url opens in-app; a normal URL opens the browser
      isActive: true,
    },
  });
  console.log('Seeded house ad ✓');
}
main().catch(console.error).finally(() => prisma.$disconnect());