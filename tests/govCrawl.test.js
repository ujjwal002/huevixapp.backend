import { describe, it, expect } from 'vitest';
import {
  extractCandidateLinks,
  looksLikeNotification,
  contentHash,
} from '../src/services/govCrawl.parse.js';
import { createJobSchema } from '../src/validators/govJobs.schemas.js';

const HTML = `
<html><body>
  <a href="/notices/advt-05-2026-constable.pdf">Advt 05/2026: Constable Recruitment</a>
  <a href='https://bpsc.bihar.gov.in/recruitment/tre-4'>TRE 4.0 <b>Notification</b></a>
  <a href="apply.php?id=99">Apply Online — Steno Vacancy</a>
  <a href="#top">Back to top</a>
  <a href="javascript:void(0)">Menu</a>
  <a href="mailto:help@bpsc.gov.in">Contact</a>
  <a href="/gallery/photo1.jpg">Republic Day Photos</a>
  <a href="/notices/advt-05-2026-constable.pdf">Duplicate link</a>
</body></html>`;

describe('extractCandidateLinks', () => {
  it('absolutizes relative URLs, strips nested tags, skips junk, dedupes', () => {
    const links = extractCandidateLinks(HTML, 'https://csbc.bihar.gov.in/index.htm');
    const urls = links.map((l) => l.url);
    expect(urls).toContain('https://csbc.bihar.gov.in/notices/advt-05-2026-constable.pdf');
    expect(urls).toContain('https://bpsc.bihar.gov.in/recruitment/tre-4');
    expect(urls).toContain('https://csbc.bihar.gov.in/apply.php?id=99');
    // #anchor / javascript: / mailto: never survive
    expect(urls.every((u) => !u.includes('void') && !u.startsWith('mailto'))).toBe(true);
    // dedupe: the PDF appears once despite two anchors
    expect(urls.filter((u) => u.endsWith('constable.pdf'))).toHaveLength(1);
    // nested <b> stripped from title
    expect(links.find((l) => l.url.includes('tre-4')).title).toBe('TRE 4.0 Notification');
  });
});

describe('looksLikeNotification', () => {
  it('keeps PDFs and recruitment-flavoured titles/urls, drops the rest', () => {
    expect(looksLikeNotification({ url: 'https://x.gov.in/a.pdf', title: '' })).toBe(true);
    expect(looksLikeNotification({ url: 'https://x.gov.in/p', title: 'Steno Vacancy 2026' })).toBe(
      true
    );
    expect(looksLikeNotification({ url: 'https://x.gov.in/recruitment/tre', title: 'TRE' })).toBe(
      true
    );
    expect(
      looksLikeNotification({
        url: 'https://x.gov.in/gallery/p1.jpg',
        title: 'Republic Day Photos',
      })
    ).toBe(false);
  });

  it('catches Hindi-transliterated terms like bharti/rojgar', () => {
    expect(looksLikeNotification({ url: 'https://x.gov.in/p', title: 'Police Bharti 2026' })).toBe(
      true
    );
  });
});

describe('contentHash', () => {
  it('is order-independent and change-sensitive', () => {
    const a = [{ url: 'https://a' }, { url: 'https://b' }];
    const b = [{ url: 'https://b' }, { url: 'https://a' }];
    const c = [{ url: 'https://a' }, { url: 'https://c' }];
    expect(contentHash(a)).toBe(contentHash(b));
    expect(contentHash(a)).not.toBe(contentHash(c));
  });
});

describe('extraction contract (createJobSchema.body)', () => {
  const good = {
    title: 'Bihar Police Constable Recruitment 2026',
    organization: 'CSBC',
    state: 'BR',
    applyEndDate: '2026-08-15',
    eligibility: {
      genderAllowed: 'all',
      education: { minLevel: 'TWELFTH' },
      age: {
        min: 18,
        max: 25,
        asOnDate: '2026-08-01',
        relaxations: [{ categories: ['SC', 'ST'], domicile: 'BR', extraYears: 5 }],
      },
    },
    feeRules: {
      currency: 'INR',
      default: 675,
      rules: [{ gender: 'female', domicile: 'BR', amount: 180 }],
    },
  };

  it('accepts a well-formed extraction', () => {
    expect(createJobSchema.body.safeParse(good).success).toBe(true);
  });

  it('rejects a hallucinated age block missing the asOnDate cutoff', () => {
    const bad = { ...good, eligibility: { ...good.eligibility, age: { min: 18, max: 25 } } };
    expect(createJobSchema.body.safeParse(bad).success).toBe(false);
  });

  it('rejects malformed dates and unknown categories', () => {
    expect(createJobSchema.body.safeParse({ ...good, applyEndDate: '15-08-2026' }).success).toBe(
      false
    );
    const badCat = structuredClone(good);
    badCat.eligibility.age.relaxations[0].categories = ['GEN'];
    expect(createJobSchema.body.safeParse(badCat).success).toBe(false);
  });
});

describe('pdfToText', () => {
  // A real 1-page notification PDF, embedded so the parser has a regression fixture.
  const FIXTURE_B64 =
    'JVBERi0xLjMKJZOMi54gUmVwb3J0TGFiIEdlbmVyYXRlZCBQREYgZG9jdW1lbnQgKG9wZW5zb3VyY2UpCjEgMCBvYmoKPDwKL0YxIDIgMCBSCj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9CYXNlRm9udCAvSGVsdmV0aWNhIC9FbmNvZGluZyAvV2luQW5zaUVuY29kaW5nIC9OYW1lIC9GMSAvU3VidHlwZSAvVHlwZTEgL1R5cGUgL0ZvbnQKPj4KZW5kb2JqCjMgMCBvYmoKPDwKL0NvbnRlbnRzIDcgMCBSIC9NZWRpYUJveCBbIDAgMCA1OTUuMjc1NiA4NDEuODg5OCBdIC9QYXJlbnQgNiAwIFIgL1Jlc291cmNlcyA8PAovRm9udCAxIDAgUiAvUHJvY1NldCBbIC9QREYgL1RleHQgL0ltYWdlQiAvSW1hZ2VDIC9JbWFnZUkgXQo+PiAvUm90YXRlIDAgL1RyYW5zIDw8Cgo+PiAKICAvVHlwZSAvUGFnZQo+PgplbmRvYmoKNCAwIG9iago8PAovUGFnZU1vZGUgL1VzZU5vbmUgL1BhZ2VzIDYgMCBSIC9UeXBlIC9DYXRhbG9nCj4+CmVuZG9iago1IDAgb2JqCjw8Ci9BdXRob3IgKGFub255bW91cykgL0NyZWF0aW9uRGF0ZSAoRDoyMDI2MDcxODIzNTY1MCswMCcwMCcpIC9DcmVhdG9yIChhbm9ueW1vdXMpIC9LZXl3b3JkcyAoKSAvTW9kRGF0ZSAoRDoyMDI2MDcxODIzNTY1MCswMCcwMCcpIC9Qcm9kdWNlciAoUmVwb3J0TGFiIFBERiBMaWJyYXJ5IC0gXChvcGVuc291cmNlXCkpIAogIC9TdWJqZWN0ICh1bnNwZWNpZmllZCkgL1RpdGxlICh1bnRpdGxlZCkgL1RyYXBwZWQgL0ZhbHNlCj4+CmVuZG9iago2IDAgb2JqCjw8Ci9Db3VudCAxIC9LaWRzIFsgMyAwIFIgXSAvVHlwZSAvUGFnZXMKPj4KZW5kb2JqCjcgMCBvYmoKPDwKL0ZpbHRlciBbIC9BU0NJSTg1RGVjb2RlIC9GbGF0ZURlY29kZSBdIC9MZW5ndGggMjUyCj4+CnN0cmVhbQpHYXJwIzpDRGI+Ji1fUU1UQWdrSTtLbzRla2JiZFc/ajhaN28hNmQ9TzMxIUhJSl5BcTNZVll1b0IsUWZMako5cWY0UTQ6XC5ccGhpJTpucm9ZRTZyXCpCTD88U3JFXiJvKyUiME9DYENCOjUzaEtUUmYqI2pIWlApbytxTTgyOltsPTxVW0FcdCFjaForcmtLa0QuXTpNNlNaYENpajViKCF0UnVrcm8vPz43Qm5SRlYqbUpXJzJKS007ZVMmVEFQLWY/TTs9KSZeaDlvP1FzRGFjLEpLMS5DWmxfN1JMJGM9bGExUkBaMGBbZj0wUTMyVVFnTkU2aCNAfj5lbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA4CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDA2MSAwMDAwMCBuIAowMDAwMDAwMDkyIDAwMDAwIG4gCjAwMDAwMDAxOTkgMDAwMDAgbiAKMDAwMDAwMDQwMiAwMDAwMCBuIAowMDAwMDAwNDcwIDAwMDAwIG4gCjAwMDAwMDA3MzEgMDAwMDAgbiAKMDAwMDAwMDc5MCAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9JRCAKWzxmZTY2Njk5NDdkYjU2MTNjZTY0NzM4MDQwOThiMGU2ZT48ZmU2NjY5OTQ3ZGI1NjEzY2U2NDczODA0MDk4YjBlNmU+XQolIFJlcG9ydExhYiBnZW5lcmF0ZWQgUERGIGRvY3VtZW50IC0tIGRpZ2VzdCAob3BlbnNvdXJjZSkKCi9JbmZvIDUgMCBSCi9Sb290IDQgMCBSCi9TaXplIDgKPj4Kc3RhcnR4cmVmCjExMzIKJSVFT0YK';

  it('extracts text from a notification PDF', async () => {
    const { pdfToText } = await import('../src/services/govCrawl.parse.js');
    const text = await pdfToText(Buffer.from(FIXTURE_B64, 'base64'));
    expect(text).toContain('ADVERTISEMENT NO. 05/2026');
    expect(text).toContain('Rs 675');
  });
});

describe('normalizeExtraction (regression: real CSBC crawl failures)', () => {
  it('deep-prunes nested nulls the LLM returns per the prompt contract', async () => {
    const { normalizeExtraction } = await import('../src/services/govExtract.normalize.js');
    // Shape reproducing the real EXTRACTION_INVALID log lines: nulls nested
    // inside education / age / feeRules that a top-level strip missed.
    const raw = {
      title: 'Bihar Police Driver Constable 2026',
      organization: 'CSBC',
      advtNo: null,
      state: 'BR',
      totalVacancies: null,
      applyEndDate: '2026-08-20',
      eligibility: {
        genderAllowed: 'all',
        domicile: null,
        education: { minLevel: 'TWELFTH', specific: null, minPercent: null },
        age: {
          min: 20,
          max: 25,
          asOnDate: '2026-08-01',
          relaxations: [
            { categories: ['SC'], gender: null, domicile: 'BR', extraYears: 5, additive: null },
          ],
        },
        extras: null,
      },
      feeRules: { currency: 'INR', default: 675, rules: null },
    };
    const { createJobSchema } = await import('../src/validators/govJobs.schemas.js');
    const result = createJobSchema.body.safeParse(normalizeExtraction(raw));
    expect(result.success).toBe(true);
    expect(result.data.eligibility.age.relaxations[0].extraYears).toBe(5);
  });

  it('turns a cutoff-less age block into an honest VERIFY extra instead of failing or guessing', async () => {
    const { normalizeExtraction } = await import('../src/services/govExtract.normalize.js');
    const raw = {
      title: 'Steno Recruitment 2026',
      organization: 'BSSC',
      eligibility: { age: { min: 18, max: 27, asOnDate: null }, education: { minLevel: null } },
      feeRules: { currency: 'INR', default: 100 },
    };
    const out = normalizeExtraction(raw);
    expect(out.eligibility.age).toBeUndefined();
    expect(out.eligibility.education).toBeUndefined(); // pruned-to-empty block removed
    expect(out.eligibility.extras.some((x) => x.type === 'age')).toBe(true);
    const { createJobSchema } = await import('../src/validators/govJobs.schemas.js');
    expect(createJobSchema.body.safeParse(out).success).toBe(true);
  });

  it('passes through the not_a_job classification for results/admit cards', async () => {
    const { normalizeExtraction } = await import('../src/services/govExtract.normalize.js');
    const out = normalizeExtraction({
      not_a_job: true,
      docType: 'admit_card',
      reason: 'PET admit card notice',
    });
    expect(out.notAJob).toBe(true);
    expect(out.docType).toBe('admit_card');
  });
});

describe('extractLooseUrls (SPA/JSON notice boards)', () => {
  it('harvests absolute and escaped-relative doc URLs from a JSON API body', async () => {
    const { extractLooseUrls, looksLikeNotification } =
      await import('../src/services/govCrawl.parse.js');
    const json = JSON.stringify({
      data: [
        {
          title: 'Constable Recruitment 2026',
          file: 'https://ssc.gov.in/uploads/advt-const-2026.pdf',
        },
        { title: 'Answer Key', file: '\/uploads\/answer-key-mts.pdf' },
        { title: 'Circular', link: 'https://ssc.gov.in/notice/circular-77' },
      ],
    });
    const urls = extractLooseUrls(json, 'https://ssc.gov.in/api/notices');
    const hrefs = urls.map((u) => u.url);
    expect(hrefs).toContain('https://ssc.gov.in/uploads/advt-const-2026.pdf');
    expect(hrefs).toContain('https://ssc.gov.in/uploads/answer-key-mts.pdf');
    // Filename becomes a readable stand-in title
    expect(urls.find((u) => u.url.includes('advt-const')).title).toBe('advt const 2026.pdf');
    // And the existing keyword filter still applies downstream
    expect(urls.filter(looksLikeNotification).length).toBeGreaterThanOrEqual(2);
  });

  it('returns nothing useful from ordinary HTML (anchors path handles that)', async () => {
    const { extractLooseUrls } = await import('../src/services/govCrawl.parse.js');
    const urls = extractLooseUrls('<p>hello world, no links here</p>', 'https://x.gov.in');
    expect(urls).toHaveLength(0);
  });
});