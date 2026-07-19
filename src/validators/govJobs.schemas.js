import { z } from 'zod';

// Shapes match the validate() middleware: { body?, query?, params? }.
// The eligibility/feeRules schemas are the contract between whatever writes
// jobs (admin panel, crawler, LLM extractor) and the pure engine — nothing
// malformed gets into the DB, so the engine never has to defend itself.

const CATEGORY = z.enum(['UR', 'EWS', 'OBC', 'EBC', 'SC', 'ST']);
const GENDER = z.enum(['MALE', 'FEMALE', 'OTHER']);
const EDUCATION = z.enum([
  'BELOW_TENTH',
  'TENTH',
  'ITI',
  'TWELFTH',
  'DIPLOMA',
  'GRADUATE',
  'POST_GRADUATE',
  'DOCTORATE',
]);
// ISO-style 2-letter state codes ("BR", "HR", "UP"…)
const STATE_CODE = z.string().regex(/^[A-Z]{2}$/, 'Use a 2-letter state code, e.g. "BR"');
const DATE_STR = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use "YYYY-MM-DD"');

// A matcher used by both age-relaxation and fee rules. Omitted field = "any".
const ruleMatcher = {
  categories: z.array(CATEGORY).min(1).optional(),
  gender: z.enum(['male', 'female', 'any']).optional(),
  domicile: STATE_CODE.optional(),
  pwd: z.boolean().optional(),
  esm: z.boolean().optional(),
};

const relaxationRule = z.object({
  ...ruleMatcher,
  extraYears: z.number().int().min(0).max(30),
  // true → stacks on top of the best category rule (typical for PwD / ESM)
  additive: z.boolean().optional().default(false),
});

const feeRule = z.object({
  ...ruleMatcher,
  amount: z.number().min(0),
});

export const eligibilityShape = z.object({
  genderAllowed: z.enum(['all', 'male', 'female']).optional().default('all'),
  domicile: z
    .object({
      mode: z.enum(['none', 'required', 'reservation_only']).default('none'),
      state: STATE_CODE.optional(),
    })
    .refine((d) => d.mode === 'none' || !!d.state, {
      message: 'domicile.state is required when mode is not "none"',
    })
    .optional(),
  education: z
    .object({
      minLevel: EDUCATION.optional(),
      specific: z.string().max(300).optional(),
      subjectsAnyOf: z.array(z.string().max(80)).optional(),
      minPercent: z.number().min(0).max(100).optional(),
    })
    .optional(),
  age: z
    .object({
      min: z.number().int().min(14).max(60).optional(),
      max: z.number().int().min(14).max(70).optional(),
      // The #1 thing aggregators get wrong — always stored explicitly.
      asOnDate: DATE_STR,
      relaxations: z.array(relaxationRule).optional().default([]),
    })
    .optional(),
  extras: z
    .array(z.object({ label: z.string().max(300), type: z.string().max(50).optional() }))
    .optional(),
});

export const feeRulesShape = z.object({
  currency: z.string().default('INR'),
  default: z.number().min(0).nullable().optional(),
  rules: z.array(feeRule).optional().default([]), // ordered — first match wins
  coveredBy: z.enum(['cet_registration']).optional(), // Haryana model
  correctionCharge: z.number().min(0).nullable().optional(),
  note: z.string().max(300).optional(),
});

// --- user profile ----------------------------------------------------------

export const upsertProfileSchema = {
  body: z.object({
    dob: DATE_STR.optional(),
    gender: GENDER.optional(),
    category: CATEGORY.optional(),
    domicileState: STATE_CODE.optional(),
    isPwd: z.boolean().optional(),
    isExServiceman: z.boolean().optional(),
    educationLevel: EDUCATION.optional(),
    educationSubjects: z.array(z.string().max(80)).max(20).optional(),
    educationPercent: z.number().min(0).max(100).nullable().optional(),
  }),
};

// --- public listing ---------------------------------------------------------

export const listJobsSchema = {
  query: z.object({
    state: STATE_CODE.optional(), // also returns all-India jobs alongside
    status: z.enum(['OPEN', 'UPCOMING', 'CLOSED', 'all']).optional().default('OPEN'),
    q: z.string().max(120).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional().default(20),
    cursor: z.string().uuid().optional(),
  }),
};

export const jobIdParam = { params: z.object({ id: z.string().uuid() }) };

// --- admin -------------------------------------------------------------------

const jobBody = z.object({
  title: z.string().min(3).max(200),
  organization: z.string().min(2).max(120),
  sourceShortName: z.string().max(40).optional(), // links to GovJobSource by stable key
  advtNo: z.string().max(80).optional(),
  state: STATE_CODE.nullable().optional(),
  totalVacancies: z.number().int().min(1).nullable().optional(),
  applyStartDate: DATE_STR.nullable().optional(),
  applyEndDate: DATE_STR.nullable().optional(),
  examDate: DATE_STR.nullable().optional(),
  officialUrl: z.string().url().nullable().optional(),
  notificationPdfUrl: z.string().url().nullable().optional(),
  eligibility: eligibilityShape,
  feeRules: feeRulesShape,
  requiresCet: z.boolean().optional(),
  parentJobId: z.string().uuid().nullable().optional(),
  verified: z.boolean().optional(),
});

export const createJobSchema = { body: jobBody };
export const updateJobSchema = { params: jobIdParam.params, body: jobBody.partial() };