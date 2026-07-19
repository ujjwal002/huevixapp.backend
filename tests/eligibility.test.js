import { describe, it, expect } from 'vitest';
import {
  ageOnDate,
  resolveAgeRelaxation,
  resolveFee,
  checkEligibility,
  jobStatus,
  VERDICT,
} from '../src/services/eligibility.service.js';

// A CSBC-style job exercising every engine feature.
const JOB = {
  applyStartDate: new Date('2026-07-01'),
  applyEndDate: new Date('2026-08-15'),
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
    extras: [{ label: 'Physical standards apply.', type: 'physical' }],
  },
  feeRules: {
    currency: 'INR',
    default: 675,
    rules: [
      { esm: true, amount: 0 },
      { categories: ['SC', 'ST'], domicile: 'BR', amount: 180 },
      { gender: 'female', domicile: 'BR', amount: 180 },
    ],
  },
};

const baseProfile = {
  dob: new Date('2003-05-10'),
  gender: 'MALE',
  category: 'UR',
  domicileState: 'BR',
  isPwd: false,
  isExServiceman: false,
  educationLevel: 'TWELFTH',
  educationSubjects: [],
  educationPercent: null,
};

describe('ageOnDate', () => {
  it('is calendar-exact around birthdays', () => {
    // Born 2001-08-02: NOT yet 25 on 2026-08-01.
    expect(ageOnDate('2001-08-02', '2026-08-01').years).toBe(24);
    expect(ageOnDate('2001-08-01', '2026-08-01')).toEqual({ years: 25, months: 0, days: 0 });
  });
});

describe('resolveAgeRelaxation', () => {
  it('picks the matching category+gender combo (Bihar EBC split)', () => {
    const male = resolveAgeRelaxation(JOB.eligibility.age.relaxations, {
      ...baseProfile,
      category: 'EBC',
    });
    const female = resolveAgeRelaxation(JOB.eligibility.age.relaxations, {
      ...baseProfile,
      category: 'EBC',
      gender: 'FEMALE',
    });
    expect(male.extraYears).toBe(2);
    expect(female.extraYears).toBe(3);
  });

  it('stacks additive PwD relaxation on top of the best category rule', () => {
    const r = resolveAgeRelaxation(JOB.eligibility.age.relaxations, {
      ...baseProfile,
      category: 'SC',
      isPwd: true,
    });
    expect(r.extraYears).toBe(15); // 5 (SC) + 10 (PwD additive)
  });

  it('gives no category relaxation to out-of-state candidates (domicile-gated)', () => {
    const r = resolveAgeRelaxation(JOB.eligibility.age.relaxations, {
      ...baseProfile,
      category: 'SC',
      domicileState: 'UP',
    });
    expect(r.extraYears).toBe(0);
  });
});

describe('resolveFee', () => {
  it('applies the Bihar domicile trap: SC from UP pays the general fee', () => {
    const br = resolveFee(JOB.feeRules, { ...baseProfile, category: 'SC' });
    const up = resolveFee(JOB.feeRules, { ...baseProfile, category: 'SC', domicileState: 'UP' });
    expect(br.amount).toBe(180);
    expect(up.amount).toBe(675);
  });

  it('first match wins: ex-serviceman ₹0 beats the category rule below it', () => {
    const r = resolveFee(JOB.feeRules, {
      ...baseProfile,
      category: 'SC',
      isExServiceman: true,
    });
    expect(r.amount).toBe(0);
  });

  it('handles the Haryana CET model', () => {
    const r = resolveFee({ coveredBy: 'cet_registration' }, baseProfile);
    expect(r.coveredByCet).toBe(true);
    expect(r.amount).toBe(0);
  });
});

describe('checkEligibility verdicts', () => {
  it('VERIFY (not ELIGIBLE) when everything passes but extras exist', () => {
    // Physical standards can't be auto-checked → honest VERIFY.
    const r = checkEligibility(baseProfile, JOB);
    expect(r.verdict).toBe(VERDICT.VERIFY);
    expect(r.reasons).toHaveLength(0);
    expect(r.verifyPoints.some((v) => v.includes('Physical'))).toBe(true);
  });

  it('ELIGIBLE when nothing needs verification', () => {
    const noExtras = { ...JOB, eligibility: { ...JOB.eligibility, extras: [] } };
    expect(checkEligibility(baseProfile, noExtras).verdict).toBe(VERDICT.ELIGIBLE);
  });

  it('NOT_ELIGIBLE with the relaxed limit explained when over-age', () => {
    // EBC male BR: limit 25+2=27. Born 1998 → 28 on cutoff.
    const r = checkEligibility(
      { ...baseProfile, category: 'EBC', dob: new Date('1998-07-01') },
      JOB
    );
    expect(r.verdict).toBe(VERDICT.NOT_ELIGIBLE);
    expect(r.age.effectiveMax).toBe(27);
    expect(r.reasons[0]).toMatch(/27/);
  });

  it('the same over-age candidate becomes ELIGIBLE-side with PwD stacking', () => {
    const r = checkEligibility(
      { ...baseProfile, category: 'EBC', dob: new Date('1998-07-01'), isPwd: true },
      JOB
    );
    expect(r.age.effectiveMax).toBe(37); // 25 + 2 + 10
    expect(r.verdict).not.toBe(VERDICT.NOT_ELIGIBLE);
  });

  it('NOT_ELIGIBLE on education below minimum', () => {
    const r = checkEligibility({ ...baseProfile, educationLevel: 'TENTH' }, JOB);
    expect(r.verdict).toBe(VERDICT.NOT_ELIGIBLE);
  });

  it('ITI vs 12th requirement is VERIFY, never a silent pass', () => {
    const r = checkEligibility({ ...baseProfile, educationLevel: 'ITI' }, JOB);
    expect(r.checks.education).toBe('verify');
    expect(r.verdict).toBe(VERDICT.VERIFY);
  });

  it('missing profile fields degrade to VERIFY, not a guess', () => {
    const r = checkEligibility({ ...baseProfile, dob: null }, JOB);
    expect(r.checks.age).toBe('unknown');
    expect(r.verdict).toBe(VERDICT.VERIFY);
  });

  it('hard domicile requirement fails out-of-state candidates', () => {
    const hardJob = {
      ...JOB,
      eligibility: { ...JOB.eligibility, domicile: { mode: 'required', state: 'BR' } },
    };
    const r = checkEligibility({ ...baseProfile, domicileState: 'UP' }, hardJob);
    expect(r.verdict).toBe(VERDICT.NOT_ELIGIBLE);
  });

  it('reservation_only domicile warns non-UR out-of-state users instead of failing', () => {
    const r = checkEligibility({ ...baseProfile, category: 'SC', domicileState: 'UP' }, JOB);
    expect(r.verdict).not.toBe(VERDICT.NOT_ELIGIBLE);
    expect(r.verifyPoints.some((v) => v.includes('unreserved'))).toBe(true);
  });

  it('gender-restricted posts hard-fail the other gender', () => {
    const womenOnly = {
      ...JOB,
      eligibility: { ...JOB.eligibility, genderAllowed: 'female' },
    };
    expect(checkEligibility(baseProfile, womenOnly).verdict).toBe(VERDICT.NOT_ELIGIBLE);
  });
});

describe('jobStatus', () => {
  it('derives UPCOMING / OPEN / CLOSED from dates', () => {
    expect(jobStatus(JOB, new Date('2026-06-15'))).toBe('UPCOMING');
    expect(jobStatus(JOB, new Date('2026-07-20'))).toBe('OPEN');
    expect(jobStatus(JOB, new Date('2026-09-01'))).toBe('CLOSED');
  });

  it('null end date means open till further notice', () => {
    expect(
      jobStatus(
        { applyStartDate: new Date('2026-07-01'), applyEndDate: null },
        new Date('2027-01-01')
      )
    ).toBe('OPEN');
  });
});