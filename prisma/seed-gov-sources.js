// Seed the GovJobSource registry (the 25 official bodies the crawler watches)
// plus one realistic sample job so /gov-jobs works immediately after seeding.
// Run: npm run seed:gov
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const CENTRAL = [
  {
    shortName: 'SSC',
    name: 'Staff Selection Commission',
    url: 'https://ssc.gov.in',
    crawlEveryHours: 4,
    notes: 'CGL, CHSL, MTS, GD Constable, CPO. Highest form volume.',
  },
  {
    shortName: 'RRB',
    name: 'Railway Recruitment Boards',
    url: 'https://rrbapply.gov.in',
    crawlEveryHours: 4,
    notes: 'NTPC, Group D, ALP, Technician via centralized portal.',
  },
  {
    shortName: 'IBPS',
    name: 'Institute of Banking Personnel Selection',
    url: 'https://ibps.in',
    crawlEveryHours: 6,
    notes: 'Bank PO, Clerk, SO, RRB (Gramin bank).',
  },
  {
    shortName: 'UPSC',
    name: 'Union Public Service Commission',
    url: 'https://upsc.gov.in',
    crawlEveryHours: 6,
    notes: 'Civil Services, CDS, NDA, CAPF, EPFO.',
  },
  {
    shortName: 'SBI',
    name: 'State Bank of India Careers',
    url: 'https://sbi.co.in/web/careers',
    crawlEveryHours: 8,
    notes: 'PO, Clerk, SO — recruits separately from IBPS.',
  },
  {
    shortName: 'RBI',
    name: 'Reserve Bank of India',
    url: 'https://opportunities.rbi.org.in',
    crawlEveryHours: 12,
    notes: 'Grade B, Assistant.',
  },
  {
    shortName: 'NTA',
    name: 'National Testing Agency',
    url: 'https://nta.ac.in',
    crawlEveryHours: 8,
    notes: 'NEET, CUET, UGC NET.',
  },
  {
    shortName: 'ARMY',
    name: 'Join Indian Army',
    url: 'https://joinindianarmy.nic.in',
    crawlEveryHours: 12,
    notes: 'Agniveer, tech entries.',
  },
  {
    shortName: 'IAF',
    name: 'Indian Air Force (Agnipath Vayu)',
    url: 'https://agnipathvayu.cdac.in',
    crawlEveryHours: 12,
    notes: 'Agniveer Vayu.',
  },
  {
    shortName: 'NAVY',
    name: 'Join Indian Navy',
    url: 'https://joinindiannavy.gov.in',
    crawlEveryHours: 12,
    notes: 'Agniveer, SSR.',
  },
  {
    shortName: 'GDS',
    name: 'India Post GDS',
    url: 'https://indiapostgdsonline.gov.in',
    crawlEveryHours: 6,
    notes: 'Gramin Dak Sevak — lakhs of applications, very popular in Bihar.',
  },
  {
    shortName: 'LIC',
    name: 'Life Insurance Corporation',
    url: 'https://licindia.in/careers',
    crawlEveryHours: 12,
    notes: 'AAO, ADO, Assistant.',
  },
  {
    shortName: 'ESIC',
    name: 'Employees State Insurance Corporation',
    url: 'https://esic.gov.in',
    crawlEveryHours: 12,
    notes: 'UDC, MTS, paramedical.',
  },
];

const BIHAR = [
  {
    shortName: 'BPSC',
    name: 'Bihar Public Service Commission',
    url: 'https://bpsc.bihar.gov.in',
    state: 'BR',
    crawlEveryHours: 4,
    notes: 'CCE, Teacher Recruitment (TRE). Most important state source.',
  },
  {
    shortName: 'BSSC',
    name: 'Bihar Staff Selection Commission',
    url: 'https://bssc.bihar.gov.in',
    state: 'BR',
    crawlEveryHours: 6,
    notes: 'Inter Level, Graduate Level.',
  },
  {
    shortName: 'CSBC',
    name: 'Central Selection Board of Constables',
    url: 'https://csbc.bihar.gov.in',
    state: 'BR',
    crawlEveryHours: 6,
    notes: 'Bihar Police Constable, Fireman. Huge applicant base.',
  },
  {
    shortName: 'BPSSC',
    name: 'Bihar Police Subordinate Services Commission',
    url: 'https://bpssc.bihar.gov.in',
    state: 'BR',
    crawlEveryHours: 8,
    notes: 'Police SI, Sergeant, Excise SI.',
  },
  {
    shortName: 'BTSC',
    name: 'Bihar Technical Service Commission',
    url: 'https://btsc.bihar.gov.in',
    state: 'BR',
    crawlEveryHours: 8,
    notes: 'ANM, staff nurse, JE, pharmacist.',
  },
  {
    shortName: 'SHSB',
    name: 'State Health Society Bihar',
    url: 'https://shs.bihar.gov.in',
    state: 'BR',
    crawlEveryHours: 12,
    notes: 'CHO and contractual health recruitment.',
  },
  {
    shortName: 'PHC',
    name: 'Patna High Court / Bihar Vidhan Sabha',
    url: 'https://patnahighcourt.gov.in',
    state: 'BR',
    crawlEveryHours: 24,
    notes: 'Clerk, stenographer, PA posts.',
  },
];

const HARYANA = [
  {
    shortName: 'HSSC',
    name: 'Haryana Staff Selection Commission',
    url: 'https://hssc.gov.in',
    state: 'HR',
    crawlEveryHours: 4,
    requiresCet: true,
    notes: 'Group C & D, Police, Clerk, Patwari. CET model: track CET cycles AND post-ads.',
  },
  {
    shortName: 'HPSC',
    name: 'Haryana Public Service Commission',
    url: 'https://hpsc.gov.in',
    state: 'HR',
    crawlEveryHours: 8,
    notes: 'HCS, Assistant Professor, Naib Tehsildar.',
  },
  {
    shortName: 'HKRN',
    name: 'Haryana Kaushal Rozgar Nigam',
    url: 'https://hkrnl.itiharyana.gov.in',
    state: 'HR',
    crawlEveryHours: 8,
    notes: 'Contractual govt jobs. Poorly covered by aggregators — our gap.',
  },
  {
    shortName: 'BSEH',
    name: 'Board of School Education Haryana (HTET)',
    url: 'https://bseh.org.in',
    state: 'HR',
    crawlEveryHours: 24,
    notes: 'HTET — required for Haryana teaching jobs.',
  },
  {
    shortName: 'PHHC',
    name: 'Punjab & Haryana High Court',
    url: 'https://highcourtchd.gov.in',
    state: 'HR',
    crawlEveryHours: 24,
    notes: 'Clerk, stenographer, judiciary staff (covers both states).',
  },
];

// A realistic sample: CSBC-style constable recruitment showing every engine
// feature — the Bihar EBC gender-split relaxation, the domicile-gated fee
// concession, PwD additive relaxation, and a physical-standards extra.
const SAMPLE_JOB = {
  title: 'Bihar Police Constable Recruitment 2026 (Sample)',
  organization: 'CSBC',
  advtNo: 'SAMPLE-01/2026',
  state: 'BR',
  totalVacancies: 21391,
  applyStartDate: new Date('2026-07-01'),
  applyEndDate: new Date('2026-08-15'),
  officialUrl: 'https://csbc.bihar.gov.in',
  verified: true,
  eligibility: {
    genderAllowed: 'all',
    domicile: { mode: 'reservation_only', state: 'BR' },
    education: { minLevel: 'TWELFTH' },
    age: {
      min: 18,
      max: 25,
      asOnDate: '2026-08-01',
      relaxations: [
        { categories: ['EBC', 'OBC'], gender: 'male', domicile: 'BR', extraYears: 2 },
        { categories: ['EBC', 'OBC'], gender: 'female', domicile: 'BR', extraYears: 3 },
        { categories: ['SC', 'ST'], domicile: 'BR', extraYears: 5 },
        { pwd: true, extraYears: 10, additive: true },
      ],
    },
    extras: [
      {
        label: 'Physical standards (height/chest/running) apply — see notification.',
        type: 'physical',
      },
    ],
  },
  feeRules: {
    currency: 'INR',
    default: 675,
    rules: [
      { esm: true, amount: 0 },
      { categories: ['SC', 'ST'], domicile: 'BR', amount: 180 },
      { gender: 'female', domicile: 'BR', amount: 180 },
      { pwd: true, amount: 180 },
    ],
    correctionCharge: null,
  },
};

async function main() {
  const sources = [...CENTRAL, ...BIHAR, ...HARYANA];
  for (const s of sources) {
    await prisma.govJobSource.upsert({
      where: { shortName: s.shortName },
      create: s,
      update: s,
    });
  }
  console.log(`Seeded ${sources.length} sources.`);

  const csbc = await prisma.govJobSource.findUnique({ where: { shortName: 'CSBC' } });
  const existing = await prisma.govJob.findFirst({
    where: { advtNo: SAMPLE_JOB.advtNo, organization: 'CSBC' },
  });
  if (!existing) {
    await prisma.govJob.create({ data: { ...SAMPLE_JOB, sourceId: csbc.id } });
    console.log('Seeded 1 sample job (CSBC constable).');
  } else {
    console.log('Sample job already present, skipping.');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());