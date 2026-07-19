// Government-job eligibility engine.
//
// Design principle: PURE FUNCTIONS, NO I/O. Everything here takes plain objects
// (a user's EligibilityProfile row + a GovJob's `eligibility`/`feeRules` JSON)
// and returns plain objects. That keeps the engine unit-testable without a DB
// and lets controllers evaluate many jobs in-process for a feed at ~zero cost.
//
// Verdicts are deliberately THREE-state, not two:
//   ELIGIBLE      — every hard criterion passes and nothing needs verification.
//   NOT_ELIGIBLE  — at least one hard criterion definitively fails.
//   VERIFY        — no hard fail, but something is unknown or ambiguous
//                   (missing profile field, degree-equivalence questions,
//                   percent requirements we can't confirm, physical standards…).
// A confident wrong "ELIGIBLE" destroys user trust; VERIFY keeps us honest.

export const VERDICT = Object.freeze({
  ELIGIBLE: 'ELIGIBLE',
  NOT_ELIGIBLE: 'NOT_ELIGIBLE',
  VERIFY: 'VERIFY',
});

// Ordered ranks for minimum-education comparison. ITI shares a rank with 12th
// because many notifications accept "10th + ITI" as 12th-equivalent — but that
// equivalence varies per notification, so ITI-vs-TWELFTH is resolved as VERIFY
// below, never as a silent pass.
const EDUCATION_RANK = Object.freeze({
  BELOW_TENTH: 0,
  TENTH: 1,
  ITI: 2,
  TWELFTH: 2,
  DIPLOMA: 3,
  GRADUATE: 4,
  POST_GRADUATE: 5,
  DOCTORATE: 6,
});

/**
 * Exact calendar age on a given date.
 * Government notifications compute age "as on <cutoff date>", so this must be
 * calendar-accurate (a candidate born 2001-08-02 is NOT 25 on 2026-08-01).
 * @param {Date|string} dob
 * @param {Date|string} asOn
 * @returns {{ years:number, months:number, days:number }}
 */
export function ageOnDate(dob, asOn) {
  const b = toUtcDate(dob);
  const a = toUtcDate(asOn);
  let years = a.getUTCFullYear() - b.getUTCFullYear();
  let months = a.getUTCMonth() - b.getUTCMonth();
  let days = a.getUTCDate() - b.getUTCDate();
  if (days < 0) {
    months -= 1;
    // Days in the month preceding `asOn`.
    days += new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), 0)).getUTCDate();
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  return { years, months, days };
}

function toUtcDate(d) {
  const x = d instanceof Date ? d : new Date(d);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()));
}

/**
 * Does a single relaxation/fee rule match this profile?
 * Every matcher field is optional; an omitted/null field means "any".
 * `domicile` on a rule means "profile must be domiciled in this state" — this
 * is the Bihar trap: SC/women fee concessions there apply ONLY to Bihar
 * domicile, which aggregator sites regularly get wrong.
 */
function ruleMatches(rule, profile) {
  if (rule.categories?.length && !rule.categories.includes(profile.category)) return false;
  if (rule.gender && rule.gender !== 'any' && rule.gender !== normGender(profile.gender))
    return false;
  if (rule.domicile && rule.domicile !== profile.domicileState) return false;
  if (rule.pwd === true && !profile.isPwd) return false;
  if (rule.esm === true && !profile.isExServiceman) return false;
  return true;
}

function normGender(g) {
  if (!g) return null;
  return String(g).toLowerCase(); // enum MALE/FEMALE/OTHER -> male/female/other
}

/**
 * Resolve total age relaxation (extra years beyond the base max age).
 * Non-additive rules compete: we take the single best (max extraYears).
 * Additive rules (typically PwD / ex-serviceman, flagged `additive: true` in
 * the job JSON) stack ON TOP of the best non-additive rule — e.g. SC + PwD in
 * many notifications = 5 + 10 = 15 years.
 * @returns {{ extraYears:number, applied:Array<object> }}
 */
export function resolveAgeRelaxation(relaxations, profile) {
  const applied = [];
  let base = 0;
  let baseRule = null;
  let additive = 0;
  for (const rule of relaxations || []) {
    if (!ruleMatches(rule, profile)) continue;
    if (rule.additive) {
      additive += rule.extraYears;
      applied.push(rule);
    } else if (rule.extraYears > base) {
      base = rule.extraYears;
      baseRule = rule;
    }
  }
  if (baseRule) applied.unshift(baseRule);
  return { extraYears: base + additive, applied };
}

/**
 * Resolve the application fee for this profile.
 * Rules are an ordered list — FIRST MATCH WINS — falling back to `default`.
 * Order matters and is an editorial decision made when the job is entered
 * (e.g. the ₹0 ex-serviceman rule should sit above a ₹180 category rule).
 * @returns {{ amount:number|null, currency:string, matchedRule:object|null, coveredByCet:boolean }}
 */
export function resolveFee(feeRules, profile) {
  const currency = feeRules?.currency || 'INR';
  if (feeRules?.coveredBy === 'cet_registration') {
    // Haryana model: the fee was paid at CET registration, not per post.
    return { amount: 0, currency, matchedRule: null, coveredByCet: true };
  }
  for (const rule of feeRules?.rules || []) {
    if (ruleMatches(rule, profile)) {
      return { amount: rule.amount, currency, matchedRule: rule, coveredByCet: false };
    }
  }
  return {
    amount: feeRules?.default ?? null,
    currency,
    matchedRule: null,
    coveredByCet: false,
  };
}

/** Derive OPEN/UPCOMING/CLOSED purely from dates (no stored status to go stale). */
export function jobStatus(job, now = new Date()) {
  const start = job.applyStartDate ? toUtcDate(job.applyStartDate) : null;
  const end = job.applyEndDate ? toUtcDate(job.applyEndDate) : null;
  const today = toUtcDate(now);
  if (start && today < start) return 'UPCOMING';
  if (end && today > end) return 'CLOSED';
  return 'OPEN';
}

/**
 * The main entry point: match one profile against one job.
 *
 * @param {object|null} profile  EligibilityProfile row (or null if the user
 *                               hasn't filled one — everything becomes VERIFY).
 * @param {object} job           GovJob row; reads `job.eligibility` and
 *                               `job.feeRules` JSON.
 * @returns {{
 *   verdict: 'ELIGIBLE'|'NOT_ELIGIBLE'|'VERIFY',
 *   reasons: string[],          // why NOT_ELIGIBLE (hard fails)
 *   verifyPoints: string[],     // what the user must confirm in the PDF
 *   checks: object,             // per-criterion breakdown for the UI
 *   fee: object,                // resolved fee for THIS user
 *   age: object|null,           // their age, relaxed limit, margin
 *   status: string,             // OPEN / UPCOMING / CLOSED
 * }}
 */
export function checkEligibility(profile, job, now = new Date()) {
  const e = job.eligibility || {};
  const reasons = [];
  const verifyPoints = [];
  const checks = {};
  const p = profile || {};

  // --- Gender -------------------------------------------------------------
  const genderAllowed = e.genderAllowed || 'all';
  if (genderAllowed !== 'all') {
    if (!p.gender) {
      checks.gender = 'unknown';
      verifyPoints.push('This post is restricted by gender; add gender to your profile.');
    } else if (normGender(p.gender) !== genderAllowed) {
      checks.gender = 'fail';
      reasons.push(`This post is open to ${genderAllowed} candidates only.`);
    } else {
      checks.gender = 'pass';
    }
  } else {
    checks.gender = 'pass';
  }

  // --- Domicile -----------------------------------------------------------
  // mode 'required'        -> hard requirement to apply at all
  // mode 'reservation_only'-> anyone may apply, but category/fee benefits need
  //                           state domicile (typical Bihar pattern). Never a
  //                           hard fail — surfaced as a verify note instead.
  const dom = e.domicile || { mode: 'none' };
  if (dom.mode === 'required') {
    if (!p.domicileState) {
      checks.domicile = 'unknown';
      verifyPoints.push(`Requires ${dom.state} domicile; add your domicile state to your profile.`);
    } else if (p.domicileState !== dom.state) {
      checks.domicile = 'fail';
      reasons.push(`Only candidates with ${dom.state} domicile can apply.`);
    } else {
      checks.domicile = 'pass';
    }
  } else if (dom.mode === 'reservation_only') {
    checks.domicile = 'pass';
    if (p.domicileState !== dom.state && p.category && p.category !== 'UR') {
      verifyPoints.push(
        `Category reservation & fee concessions apply only to ${dom.state} domicile; ` +
          `you may need to apply under the unreserved (UR) quota.`
      );
    }
  } else {
    checks.domicile = 'pass';
  }

  // --- Age ----------------------------------------------------------------
  let ageBlock = null;
  if (e.age) {
    if (!p.dob) {
      checks.age = 'unknown';
      verifyPoints.push('Add your date of birth to check the age limit.');
    } else {
      const asOn = e.age.asOnDate || now;
      const myAge = ageOnDate(p.dob, asOn);
      const relax = resolveAgeRelaxation(e.age.relaxations, p);
      const effectiveMax = e.age.max != null ? e.age.max + relax.extraYears : null;
      const overMax =
        effectiveMax != null &&
        (myAge.years > effectiveMax ||
          (myAge.years === effectiveMax && (myAge.months > 0 || myAge.days > 0)));
      const underMin = e.age.min != null && myAge.years < e.age.min;

      ageBlock = {
        yourAge: myAge,
        asOnDate: asOn,
        baseMax: e.age.max ?? null,
        relaxationYears: relax.extraYears,
        effectiveMax,
        min: e.age.min ?? null,
        appliedRelaxations: relax.applied,
      };

      if (underMin) {
        checks.age = 'fail';
        reasons.push(
          `Minimum age is ${e.age.min}; you are ${myAge.years} on the cutoff date ` +
            `(${fmtDate(asOn)}).`
        );
      } else if (overMax) {
        checks.age = 'fail';
        reasons.push(
          `Maximum age for you is ${effectiveMax}` +
            (relax.extraYears ? ` (${e.age.max} + ${relax.extraYears} relaxation)` : '') +
            `; you are ${myAge.years}y ${myAge.months}m on ${fmtDate(asOn)}.`
        );
      } else {
        checks.age = 'pass';
      }
    }
  } else {
    checks.age = 'pass';
  }

  // --- Education ----------------------------------------------------------
  const edu = e.education || {};
  if (edu.minLevel) {
    if (!p.educationLevel) {
      checks.education = 'unknown';
      verifyPoints.push('Add your highest qualification to check the education requirement.');
    } else {
      const need = EDUCATION_RANK[edu.minLevel];
      const have = EDUCATION_RANK[p.educationLevel];
      if (have < need) {
        checks.education = 'fail';
        reasons.push(
          `Requires ${humanLevel(edu.minLevel)}; your profile says ${humanLevel(p.educationLevel)}.`
        );
      } else if (p.educationLevel === 'ITI' && edu.minLevel === 'TWELFTH') {
        // Same rank, but 10th+ITI ≡ 12th only if THIS notification says so.
        checks.education = 'verify';
        verifyPoints.push(
          'Confirm in the notification whether 10th + ITI is accepted as 12th-equivalent.'
        );
      } else {
        checks.education = 'pass';
      }
      // Requirements our structured profile can't fully confirm → VERIFY, never
      // a silent pass and never a hard fail.
      if (edu.specific) {
        verifyPoints.push(
          `Specific qualification required: ${edu.specific}. Confirm yours matches.`
        );
        if (checks.education === 'pass') checks.education = 'verify';
      }
      if (edu.subjectsAnyOf?.length) {
        const mine = (p.educationSubjects || []).map((s) => s.toLowerCase());
        const hit = edu.subjectsAnyOf.some((s) => mine.includes(s.toLowerCase()));
        if (!hit) {
          verifyPoints.push(`Requires one of these subjects: ${edu.subjectsAnyOf.join(', ')}.`);
          if (checks.education === 'pass') checks.education = 'verify';
        }
      }
      if (edu.minPercent != null) {
        if (p.educationPercent == null) {
          verifyPoints.push(
            `Requires minimum ${edu.minPercent}% marks; add your percentage to confirm.`
          );
          if (checks.education === 'pass') checks.education = 'verify';
        } else if (p.educationPercent < edu.minPercent) {
          checks.education = 'fail';
          reasons.push(
            `Requires ${edu.minPercent}% marks; your profile says ${p.educationPercent}%.`
          );
        }
      }
    }
  } else {
    checks.education = 'pass';
  }

  // --- Extras (physical standards, attempts, language tests…) -------------
  // v1 policy: never evaluated, always surfaced for the user to check.
  for (const extra of e.extras || []) {
    verifyPoints.push(extra.label || String(extra));
  }

  // --- Fee (informational, never affects the verdict) ---------------------
  const fee = resolveFee(job.feeRules, p);

  // --- Verdict ------------------------------------------------------------
  let verdict = VERDICT.ELIGIBLE;
  if (reasons.length) verdict = VERDICT.NOT_ELIGIBLE;
  else if (verifyPoints.length) verdict = VERDICT.VERIFY;

  return {
    verdict,
    reasons,
    verifyPoints,
    checks,
    fee,
    age: ageBlock,
    status: jobStatus(job, now),
  };
}

function humanLevel(level) {
  const map = {
    BELOW_TENTH: 'below 10th',
    TENTH: '10th pass',
    ITI: 'ITI',
    TWELFTH: '12th pass',
    DIPLOMA: 'Diploma',
    GRADUATE: 'Graduation',
    POST_GRADUATE: 'Post-graduation',
    DOCTORATE: 'Doctorate',
  };
  return map[level] || level;
}

function fmtDate(d) {
  return toUtcDate(d).toISOString().slice(0, 10);
}