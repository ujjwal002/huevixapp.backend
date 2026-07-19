// PURE normalization of raw LLM extraction output, before Zod validation.
// Split from govExtract.service.js so it's unit-testable without prisma —
// these transforms encode lessons from real crawl runs, so they need tests.

/** Recursively drop null/undefined values (arrays keep their order). */
export function pruneNulls(value) {
  if (Array.isArray(value)) {
    return value.filter((v) => v !== null && v !== undefined).map(pruneNulls);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined) continue;
      out[k] = pruneNulls(v);
    }
    return out;
  }
  return value;
}

/**
 * Shape raw LLM output into something createJobSchema.body can validate.
 *
 * Why: the prompt (correctly) tells the model "use null, never guess" — but the
 * Zod shapes use .optional(), which accepts ABSENT, not null. Real runs against
 * CSBC produced e.g. education.minLevel: null nested three levels deep, so the
 * prune must be recursive, not top-level.
 *
 * Honesty rule for partial extractions: if an age block survives but lost its
 * asOnDate cutoff, we don't validate a half-age (would fail) and we don't drop
 * it silently (engine would show age "pass" for a job that HAS a limit).
 * Instead the age block becomes an extras note — the user gets VERIFY, which
 * is the truthful verdict.
 *
 * @returns {{ notAJob: true, docType?:string, reason?:string } | object}
 */
export function normalizeExtraction(raw) {
  if (raw && raw.not_a_job === true) {
    return { notAJob: true, docType: raw.docType || 'other', reason: raw.reason || '' };
  }
  const data = pruneNulls(raw);

  if (data.eligibility) {
    const e = data.eligibility;

    // Half-extracted age (no cutoff) → honest VERIFY note instead of a guess.
    if (e.age && !e.age.asOnDate) {
      delete e.age;
      e.extras = e.extras || [];
      e.extras.push({
        label: 'Age limit could not be auto-extracted — check the notification.',
        type: 'age',
      });
    }
    // Same for a domicile block that lost its state.
    if (e.domicile && e.domicile.mode && e.domicile.mode !== 'none' && !e.domicile.state) {
      delete e.domicile;
      e.extras = e.extras || [];
      e.extras.push({
        label: 'Domicile requirement could not be auto-extracted — check the notification.',
        type: 'domicile',
      });
    }
    // An education block reduced to nothing is just noise.
    if (e.education && Object.keys(e.education).length === 0) delete e.education;
  }
  return data;
}