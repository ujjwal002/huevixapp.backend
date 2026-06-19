import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  // Match the app's configured bcrypt cost (BCRYPT_ROUNDS, default 12) so
  // seeded accounts are hashed consistently with ones created via /register.
  const rounds = parseInt(process.env.BCRYPT_ROUNDS || '12', 10) || 12;
  const passwordHash = await bcrypt.hash('Password123', rounds);

  const admin = await prisma.user.upsert({
    where: { email: 'admin@lingoshorts.app' },
    update: {},
    create: {
      email: 'admin@lingoshorts.app',
      passwordHash,
      name: 'Admin',
      role: 'ADMIN',
      nativeLanguage: 'hi',
      targetLanguage: 'en',
    },
  });

  await prisma.user.upsert({
    where: { email: 'learner@lingoshorts.app' },
    update: {},
    create: {
      email: 'learner@lingoshorts.app',
      passwordHash,
      name: 'Test Learner',
      role: 'USER',
      nativeLanguage: 'hi',
      targetLanguage: 'en',
      freeSpeakingCreditsRemaining: 3,
    },
  });

  const existing = await prisma.card.findFirst({ where: { title: 'Nailing the First Impression' } });
  if (!existing) {
    await prisma.card.create({
      data: {
        targetLanguage: 'en',
        level: 'INTERMEDIATE',
        topic: 'interview',
        title: 'Nailing the First Impression',
        body:
          'In a job interview, the first few minutes are crucial. Recruiters often form an impression before you even sit down. Maintain steady eye contact, offer a firm handshake, and articulate your strengths with concrete examples. Avoid vague statements; instead, quantify your achievements. Preparation conveys confidence, and confidence is contagious.',
        wordCount: 52,
        isPublished: true,
        audioStatus: 'PENDING',
        vocab: {
          create: [
            { nativeLanguage: 'hi', term: 'crucial', partOfSpeech: 'adjective', meaning: 'अत्यंत महत्वपूर्ण', example: 'These minutes are crucial.' },
            { nativeLanguage: 'hi', term: 'articulate', partOfSpeech: 'verb', meaning: 'स्पष्ट रूप से व्यक्त करना', example: 'Articulate your strengths.' },
            { nativeLanguage: 'hi', term: 'quantify', partOfSpeech: 'verb', meaning: 'संख्या में मापना', example: 'Quantify your achievements.' },
            { nativeLanguage: 'hi', term: 'contagious', partOfSpeech: 'adjective', meaning: 'आसानी से फैलने वाला', example: 'Confidence is contagious.' },
          ],
        },
      },
    });
  }

  console.log('Seed complete.');
  console.log('Admin login:   admin@lingoshorts.app / Password123');
  console.log('Learner login: learner@lingoshorts.app / Password123');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
