const assert = require('assert');
const { extractReferencesFromText, stripPageHeaders } = require('./server');

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
console.log('header regression test passed');
