const assert = require('assert');
const {
  extractReferencesFromText,
  stripPageHeaders,
  buildAnalyzeResponse,
  scoreCandidateMatch,
  rankCandidates,
  normalizeCrossrefWork,
  normalizeDoi,
  mapWithConcurrency,
  describeLookupError
} = require('./server');

const sample = `
A Very Long Paper Title
Authors Name and Affiliation
Abstract
This is the abstract.
References
[1] Author A, Author B. Title one. Journal 2020.
[2] Author C, Author D. Title two. Journal 2021.
`;

const cleaned = stripPageHeaders(sample);
assert.ok(!cleaned.includes('A Very Long Paper Title'));
assert.ok(!cleaned.includes('Authors Name and Affiliation'));
assert.ok(!cleaned.includes('This is the abstract.'));

const refs = extractReferencesFromText(sample);
assert.strictEqual(refs.length, 2);
assert.ok(refs[0].includes('[1] Author A'));
assert.ok(refs[1].includes('[2] Author C'));

const longBlockSample = `References [15] First citation text that should be its own reference. [16] Second citation text that should also be its own reference. [2] Third citation text that should be separated too.`;
const longBlockRefs = extractReferencesFromText(longBlockSample);
assert.strictEqual(longBlockRefs.length, 3);
assert.ok(longBlockRefs[0].includes('[15]'));
assert.ok(longBlockRefs[1].includes('[16]'));
assert.ok(longBlockRefs[2].includes('[2]'));

const doiSample = `References\n[1] Smith, J. and Doe, A. Title of a paper. Journal of Testing 2020. doi:10.1000/abcd1234\n[2] Brown, K. Another title. Journal of Testing 2021.`;
const doiRefs = extractReferencesFromText(doiSample);
assert.strictEqual(doiRefs.length, 2);
assert.ok(doiRefs[0].includes('doi:10.1000/abcd1234'));
assert.ok(doiRefs[1].includes('[2]'));

const inlineMarkerSample = `References\n[1] Author A, Author B. Title one. Journal 2020.\nThis is still part of the same reference.\n[2] Author C, Author D. Title two. Journal 2021.`;
const inlineMarkerRefs = extractReferencesFromText(inlineMarkerSample);
assert.strictEqual(inlineMarkerRefs.length, 2);
assert.ok(inlineMarkerRefs[0].includes('This is still part of the same reference'));

const scoredMatch = scoreCandidateMatch('Smith, J. and Doe, A. Title of a paper. Journal of Testing 2020.', {
  title: 'Title of a paper',
  containerTitle: 'Journal of Testing',
  authors: 'Smith, Doe',
  year: 2020
});
assert.strictEqual(scoredMatch.confidence, 'high');
assert.ok(scoredMatch.evidence.some((line) => line.includes('Year matched: 2020')));

const mismatchMatch = scoreCandidateMatch('Smith, J. Title of a paper. Journal of Testing 2020.', {
  title: 'Completely unrelated research methods',
  containerTitle: 'Other Journal',
  authors: 'Johnson',
  year: 2023
});
assert.strictEqual(mismatchMatch.confidence, 'low');
assert.ok(mismatchMatch.evidence.some((line) => line.includes('Year mismatch')));

const rankedCandidates = rankCandidates('Smith, J. and Doe, A. Title of a paper. Journal of Testing 2020.', [
  { title: 'Unrelated work', containerTitle: 'Other Journal', authors: 'Someone', year: 2018, doi: '10.1000/nope' },
  { title: 'Title of a paper', containerTitle: 'Journal of Testing', authors: 'Smith, Doe', year: 2020, doi: '10.1000/match' }
]);
assert.strictEqual(rankedCandidates[0].doi, '10.1000/match');

const normalizedWork = normalizeCrossrefWork({
  DOI: '10.1000/ABC.',
  title: ['Normalized title'],
  author: [{ given: 'Jane', family: 'Smith' }],
  'container-title': ['Journal of Testing'],
  issued: { 'date-parts': [[2022, 5, 1]] }
});
assert.strictEqual(normalizedWork.doi, '10.1000/abc');
assert.strictEqual(normalizedWork.title, 'Normalized title');
assert.strictEqual(normalizedWork.year, 2022);
assert.strictEqual(normalizeDoi('10.1000/ABC.'), '10.1000/abc');

const responseWithoutDebug = buildAnalyzeResponse({
  filename: 'paper.pdf',
  extracted: { processed: 'processed text', raw: 'raw text', cleaned: 'cleaned text' },
  references: [{ reference: 'ref' }],
  engineVersion: 'test',
  debugRequested: false,
  debugOutput: ['trace line']
});
assert.strictEqual(responseWithoutDebug.debugOutput, null);
assert.strictEqual(responseWithoutDebug.rawExtractedText, null);
assert.strictEqual(responseWithoutDebug.cleanedExtractedText, null);
assert.strictEqual(responseWithoutDebug.processedExtractedText, null);

const responseWithDebug = buildAnalyzeResponse({
  filename: 'paper.pdf',
  extracted: { processed: 'processed text', raw: 'raw text', cleaned: 'cleaned text' },
  references: [{ reference: 'ref' }],
  engineVersion: 'test',
  debugRequested: true,
  debugOutput: ['trace line']
});
assert.strictEqual(responseWithDebug.debugOutput, 'trace line');
assert.strictEqual(responseWithDebug.rawExtractedText, 'raw text');
assert.strictEqual(responseWithDebug.cleanedExtractedText, 'cleaned text');
assert.strictEqual(responseWithDebug.processedExtractedText, 'processed text');

assert.strictEqual(describeLookupError(new Error('Remote request failed with status 429')), 'Remote request failed with status 429');
assert.strictEqual(describeLookupError(null), 'unknown error');

async function runAsyncTests() {
  let active = 0;
  let maxActive = 0;
  const mapped = await mapWithConcurrency([1, 2, 3, 4], 2, async (value) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });

  assert.deepStrictEqual(mapped, [2, 4, 6, 8]);
  assert.ok(maxActive <= 2);
}

runAsyncTests()
  .then(() => console.log('header regression test passed'))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
