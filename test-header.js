const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  extractReferencesFromText,
  cleanExtractedText,
  reorderTextForColumns,
  stripPageHeaders,
  buildAnalyzeResponse,
  looksLikeExtractedReferences,
  scoreCandidateMatch,
  rankCandidates,
  normalizeCrossrefWork,
  parseArxivFeed,
  normalizeDoi,
  mapWithConcurrency,
  describeLookupError,
  confidenceForLookupError,
  analyzeReference,
  extractReferenceMetadata,
  extractDoi,
  extractArxivIdentifier,
  shouldSearchArxiv,
  fetchWithTimeout,
  isRetriableArxivStatus,
  isViableSearchCandidate,
  fetchArxivEntriesByIds,
  repairDoiWrapping
} = require('./server');

const clientHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
assert.ok(clientHtml.includes('${renderCitationText(ref.reference)}'));
const renderCitationTextSource = clientHtml.slice(
  clientHtml.indexOf('function renderCitationText(reference)'),
  clientHtml.indexOf('function metadataValue(metadata, key)')
);
const renderCitationText = new Function('escapeHtml', `${renderCitationTextSource}; return renderCitationText;`)(
  (value) => String(value || '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]))
);
const linkedCitation = renderCitationText('Fixture <record>. doi: 10.1000/example.2026.7.');
assert.ok(linkedCitation.includes('Fixture &lt;record&gt;. doi:'));
assert.ok(linkedCitation.includes('href="https://doi.org/10.1000/example.2026.7"'));
assert.ok(linkedCitation.includes('>10.1000/example.2026.7</a>.'));

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

const mergedHeadingSample = `
1. A numbered survey response in the body must not become a citation.
[7] A body paragraph can begin with an in-text citation after column reordering.
Acknowledgments References
[1] Avery Fixture. 2024. First synthetic citation. Journal of Parser Fixtures 1, 1, 1–4.
[2] Blair Sample. 2025. Second synthetic citation. Journal of Parser Fixtures 2, 1, 5–8.
[3] Casey Harness. 2026. Third synthetic citation. Journal of Parser Fixtures 3, 1, 9–12.
`;
const mergedHeadingRefs = extractReferencesFromText(mergedHeadingSample);
assert.strictEqual(mergedHeadingRefs.length, 3);
assert.ok(mergedHeadingRefs[0].startsWith('[1] Avery Fixture'));
assert.ok(mergedHeadingRefs[1].startsWith('[2] Blair Sample'));
assert.ok(mergedHeadingRefs[2].startsWith('[3] Casey Harness'));

const structuralBoundarySample = `Bibliography
[1] Avery Fixture. First synthetic citation. Journal of Parser Fixtures, 2024.
[2] Blair Sample. Second synthetic citation. Journal of Parser Fixtures, 2025.
[3] Casey Harness. Third synthetic citation. Journal of Parser Fixtures, 2026.
AUTHOR PROFILE
Casey Harness is from Sampleton and studies synthetic parsers.`;
const structuralBoundaryRefs = extractReferencesFromText(structuralBoundarySample);
assert.strictEqual(structuralBoundaryRefs.length, 3);
assert.ok(!structuralBoundaryRefs[2].includes('AUTHOR PROFILE'));
assert.ok(!structuralBoundaryRefs[2].includes('Sampleton'));

const pythonHeadingRegression = spawnSync(
  path.join(__dirname, '.venv', 'bin', 'python'),
  ['-c', [
    'from scripts.extract_pdf_text import SECTION_BOUNDARY_MARKER, build_reference_groups',
    'blocks = [',
    '  (0, 0, 1, 1, "1. A numbered body item."),',
    '  (0, 1, 1, 2, "Acknowledgments References"),',
    '  (0, 2, 1, 3, "[1] Avery Fixture. 2024. First synthetic citation."),',
    '  (0, 3, 1, 4, "[2] Blair Sample. 2025. Second synthetic citation."),',
    '  (0, 4, 1, 5, "[3] Casey Harness. 2026. Third synthetic citation."),',
    '  (0, 5, 1, 6, SECTION_BOUNDARY_MARKER),',
    '  (0, 6, 1, 7, "Casey Harness is from Sampleton and studies synthetic parsers."),',
    ']',
    'groups = build_reference_groups(blocks)',
    'assert len(groups) == 3, groups',
    'assert groups[0].startswith("[1] Avery Fixture"), groups',
    'assert "SECTION_BOUNDARY" not in groups[-1], groups',
    'assert "Sampleton" not in groups[-1], groups',
  ].join('\n')],
  { cwd: __dirname, encoding: 'utf8' }
);
assert.strictEqual(pythonHeadingRegression.status, 0, pythonHeadingRegression.stderr);

const pythonSingleColumnBibliographyRegression = spawnSync(
  path.join(__dirname, '.venv', 'bin', 'python'),
  ['-c', [
    'import fitz',
    'from scripts.extract_pdf_text import is_structural_section_heading, ordered_blocks, repair_line_wrapping',
    'doc = fitz.open()',
    'page = doc.new_page(width=612, height=792)',
    'page.insert_text((258, 75), "BIBLIOGRAPHY")',
    'page.insert_text((78, 115), "[1] Avery Fixture. A synthetic trailing-year title. 2024.")',
    'page.insert_text((78, 150), "[2] Blair Sample. Another synthetic trailing-year title. 2025.")',
    'texts = [block[4] for block in ordered_blocks(page)]',
    'assert any(text.startswith("[1]") for text in texts), texts',
    'assert any(text.startswith("[2]") for text in texts), texts',
    'continuation_page = doc.new_page(width=612, height=792)',
    'continuation_page.insert_text((98, 75), "ceedings of the Synthetic Fixture Conference.")',
    'continuation_texts = [block[4] for block in ordered_blocks(continuation_page)]',
    'assert any(text.startswith("ceedings") for text in continuation_texts), continuation_texts',
    'section_page = doc.new_page(width=612, height=792)',
    'section_page.insert_text((258, 75), "Next Section", fontsize=14)',
    'section_page.insert_text((72, 120), "Synthetic body text beneath the new section heading.", fontsize=11)',
    'section_page.insert_text((72, 145), "Additional synthetic body text for typography comparison.", fontsize=11)',
    'section_blocks = ordered_blocks(section_page)',
    'assert any(is_structural_section_heading(section_page, block) for block in section_blocks), section_blocks',
    'assert repair_line_wrapping("Avery Fixture- Sample") == "Avery Fixture-Sample"',
    'duplicate_doi = repair_line_wrapping("Synthetic Journal, 2026. doi: 10.1000/fixture.2026.7. URL https://doi.org/ 10.1000/fixture.2026.7")',
    'assert "fixture.2026.7. URL https://doi.org/10.1000/fixture.2026.7" in duplicate_doi, duplicate_doi',
    'assert "URLhttps" not in duplicate_doi, duplicate_doi',
    'assert repair_line_wrapping("doi: 10.1000/fixture. 2026") == "doi: 10.1000/fixture.2026"',
  ].join('\n')],
  { cwd: __dirname, encoding: 'utf8' }
);
assert.strictEqual(pythonSingleColumnBibliographyRegression.status, 0, pythonSingleColumnBibliographyRegression.stderr);

const pythonFlushLeftAuthorDateRegression = spawnSync(
  path.join(__dirname, '.venv', 'bin', 'python'),
  ['-c', [
    'import fitz',
    'from scripts.extract_pdf_text import build_unnumbered_reference_groups, find_reference_heading',
    'doc = fitz.open()',
    'toc = doc.new_page(width=612, height=792)',
    'toc.insert_text((72, 180), "References", fontsize=12)',
    'toc.insert_text((72, 205), "A contents entry followed by ordinary synthetic text.", fontsize=10)',
    'body = doc.new_page(width=612, height=792)',
    'body.insert_text((72, 90), "Synthetic body material without bibliography records.", fontsize=10)',
    'refs = doc.new_page(width=612, height=792)',
    'refs.insert_text((72, 70), "References", fontsize=18)',
    'refs.insert_text((72, 110), "Fixture, A. (2024). A complete synthetic article title.", fontsize=10)',
    'refs.insert_text((72, 124), "Journal of Fixture Records, 4(2), 10-19. https://doi.org/10.1000/fixture.2024.1", fontsize=10)',
    'refs.insert_text((72, 154), "Example Research Group. (2025). A synthetic organizational report.", fontsize=10)',
    'refs.insert_text((72, 168), "Example Research Group. https://example.invalid/report", fontsize=10)',
    'refs.insert_text((72, 198), "Sample, B., Harness, C., & Runner, D. (2026). A wrapped synthetic citation.", fontsize=10)',
    'refs.insert_text((72, 212), "Synthetic Review, 8(1), 20-29. https://doi.org/10.1000/fixture.2026.2", fontsize=10)',
    'after = doc.new_page(width=612, height=792)',
    'after.insert_text((72, 70), "Acknowledgments", fontsize=18)',
    'after.insert_text((72, 105), "Synthetic contributor information must not join a citation.", fontsize=10)',
    'heading_page, _ = find_reference_heading(doc)',
    'assert heading_page == 2, heading_page',
    'groups = build_unnumbered_reference_groups(doc)',
    'assert len(groups) == 3, groups',
    'assert "Journal of Fixture Records" in groups[0], groups',
    'assert groups[1].startswith("Example Research Group"), groups',
    'assert "Acknowledgments" not in groups[-1], groups',
  ].join('\n')],
  { cwd: __dirname, encoding: 'utf8' }
);
assert.strictEqual(pythonFlushLeftAuthorDateRegression.status, 0, pythonFlushLeftAuthorDateRegression.stderr);

const pythonTrailingYearAppendixRegression = spawnSync(
  path.join(__dirname, '.venv', 'bin', 'python'),
  ['-c', [
    'import fitz',
    'from scripts.extract_pdf_text import extract_document_text',
    'doc = fitz.open()',
    'refs = doc.new_page(width=612, height=792)',
    'refs.insert_text((72, 70), "References", fontsize=18)',
    'refs.insert_text((72, 110), "Avery Fixture and Blair Sample. A synthetic trailing-year article.", fontsize=10)',
    'doi_prefix = "Journal of Fixture Records, 4(2):10-19, 2024. doi: 10.1000/"',
    'refs.insert_text((82, 124), doi_prefix, fontsize=10)',
    'suffix_x = 82 + fitz.get_text_length(doi_prefix, fontsize=10) + 8',
    'refs.insert_text((suffix_x, 124), "fixture.2024.1.", fontsize=10)',
    'refs.insert_text((72, 165), "Casey Harness. Another synthetic citation without a parenthesized year.", fontsize=10)',
    'refs.insert_text((82, 179), "In Proceedings of the Fixture Evaluation Conference, pp. 20-29, 2025.", fontsize=10)',
    'continued = doc.new_page(width=612, height=792)',
    'continued.insert_text((72, 70), "Drew Runner and Emery Example. A multipage synthetic bibliography record.", fontsize=10)',
    'continued.insert_text((82, 84), "Synthetic Parsing Review, 8(1):30-39, 2026.", fontsize=10)',
    'appendix = doc.new_page(width=612, height=792)',
    'appendix.insert_text((72, 70), "A Appendix", fontsize=14)',
    'appendix.insert_text((72, 110), "1. Icon. A numbered appendix definition, not a citation.", fontsize=10)',
    'appendix.insert_text((72, 135), "2. Text. Another numbered appendix definition.", fontsize=10)',
    'appendix.insert_text((72, 160), "3. Button. A third numbered appendix definition.", fontsize=10)',
    'pdf_path = "/tmp/citecheck-trailing-year-appendix-regression.pdf"',
    'doc.save(pdf_path)',
    'groups = extract_document_text(pdf_path).split("\\n\\n")',
    'assert len(groups) == 3, groups',
    'assert groups[0].startswith("Avery Fixture"), groups',
    'assert "10.1000/fixture.2024.1" in groups[0], groups',
    'assert groups[2].startswith("Drew Runner"), groups',
    'assert not any("numbered appendix" in group.lower() for group in groups), groups',
    'print("\\n\\n".join(groups))',
  ].join('\n')],
  { cwd: __dirname, encoding: 'utf8' }
);
assert.strictEqual(pythonTrailingYearAppendixRegression.status, 0, pythonTrailingYearAppendixRegression.stderr);

const trailingYearPdfCleaned = cleanExtractedText(pythonTrailingYearAppendixRegression.stdout);
const trailingYearPdfWithoutHeaders = stripPageHeaders(trailingYearPdfCleaned);
const trailingYearPdfProcessed = looksLikeExtractedReferences(trailingYearPdfWithoutHeaders)
  ? trailingYearPdfWithoutHeaders
  : reorderTextForColumns(trailingYearPdfWithoutHeaders);
const trailingYearPdfReferences = extractReferencesFromText(trailingYearPdfProcessed);
assert.strictEqual(trailingYearPdfReferences.length, 3, trailingYearPdfReferences);
assert.ok(trailingYearPdfReferences[0].startsWith('Avery Fixture'));
assert.ok(trailingYearPdfReferences[0].includes('10.1000/fixture.2024.1'));
assert.ok(trailingYearPdfReferences[2].startsWith('Drew Runner'));
assert.ok(!trailingYearPdfReferences.some((reference) => reference.toLowerCase().includes('numbered appendix')));
assert.ok(trailingYearPdfReferences[0].endsWith('10.1000/fixture.2024.1.'));
assert.ok(trailingYearPdfReferences[1].startsWith('Casey Harness'));

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

const wrappedDoiSample = `References
[10] Avery Fixture. 2024. A DOI split after punctuation. Journal of Synthetic Records 3, 1, 10–20. doi:10.1000/example.
10001
[11] Blair Sample. 2025. A DOI split inside its registrant prefix. Journal of Synthetic Records 4, 2, 21–30. doi:10.
1000/example.10002
[12] Casey Harness. 2026. A DOI split immediately after its slash. Journal of Synthetic Records 5, 3, 31–40. https://doi.org/10.1000/
example.10003`;
const wrappedDoiRefs = extractReferencesFromText(wrappedDoiSample);
assert.strictEqual(wrappedDoiRefs.length, 3);
assert.ok(wrappedDoiRefs[0].includes('doi:10.1000/example.10001'));
assert.ok(wrappedDoiRefs[1].includes('doi:10.1000/example.10002'));
assert.ok(wrappedDoiRefs[2].includes('https://doi.org/10.1000/example.10003'));
assert.strictEqual(repairDoiWrapping('doi:10. 1000/example.10002'), 'doi:10.1000/example.10002');
const duplicateDoiForms = repairDoiWrapping('doi: 10.1000/fixture.2026.7. URL https://doi.org/ 10.1000/fixture.2026.7');
assert.strictEqual(
  duplicateDoiForms,
  'doi: 10.1000/fixture.2026.7. URL https://doi.org/10.1000/fixture.2026.7'
);
assert.strictEqual(extractDoi(duplicateDoiForms), '10.1000/fixture.2026.7');
assert.strictEqual(
  extractDoi('[4] Jordan Fixture. 2026. A Synthetic Preprint. arXiv:2601.12345v2 [cs.EX] https://arxiv.org/abs/2601.12345'),
  '10.48550/arxiv.2601.12345'
);
assert.deepStrictEqual(
  extractArxivIdentifier('[4] Jordan Fixture. 2026. A Synthetic Preprint. arXiv:2601.12345v2 [cs.EX]'),
  {
    baseId: '2601.12345',
    version: 'v2',
    requestedId: '2601.12345v2',
    canonicalDoi: '10.48550/arxiv.2601.12345'
  }
);
assert.strictEqual(extractArxivIdentifier('https://arxiv.org/abs/cs/9901002v1').requestedId, 'cs/9901002v1');

const syntheticArxivFeed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2601.12345v2</id>
    <title>Reliable Fixtures &amp; Structured Parser Tests</title>
    <published>2026-01-15T10:00:00Z</published>
    <updated>2026-02-20T11:00:00Z</updated>
    <author><name>Jordan Fixture</name></author>
    <author><name>Riley Sample</name></author>
    <category term="cs.EX" />
    <category term="cs.TEST" />
    <arxiv:primary_category term="cs.EX" />
    <arxiv:journal_ref>Journal of Synthetic Records 12 (2026) 1-9</arxiv:journal_ref>
    <arxiv:doi>10.1000/fixture.2026.12345</arxiv:doi>
    <link href="https://arxiv.org/abs/2601.12345v2" rel="alternate" type="text/html" />
  </entry>
</feed>`;
const syntheticArxivCandidate = parseArxivFeed(syntheticArxivFeed)[0];
assert.strictEqual(syntheticArxivCandidate.arxivId, '2601.12345');
assert.strictEqual(syntheticArxivCandidate.arxivVersion, 'v2');
assert.strictEqual(syntheticArxivCandidate.title, 'Reliable Fixtures & Structured Parser Tests');
assert.strictEqual(syntheticArxivCandidate.authors, 'Jordan Fixture, Riley Sample');
assert.strictEqual(syntheticArxivCandidate.year, 2026);
assert.strictEqual(syntheticArxivCandidate.primaryCategory, 'cs.EX');
assert.deepStrictEqual(syntheticArxivCandidate.categories, ['cs.EX', 'cs.TEST']);
assert.strictEqual(syntheticArxivCandidate.publicationDoi, '10.1000/fixture.2026.12345');

const inlineMarkerSample = `References\n[1] Author A, Author B. Title one. Journal 2020.\nThis is still part of the same reference.\n[2] Author C, Author D. Title two. Journal 2021.`;
const inlineMarkerRefs = extractReferencesFromText(inlineMarkerSample);
assert.strictEqual(inlineMarkerRefs.length, 2);
assert.ok(inlineMarkerRefs[0].includes('This is still part of the same reference'));

const extractedReferenceLines = `[1] First citation. Journal 2020.
[2] Second citation. Journal 2021.
[3] Third citation. Journal 2022.`;
assert.strictEqual(looksLikeExtractedReferences(extractedReferenceLines), true);
assert.strictEqual(looksLikeExtractedReferences('Introduction\nThis is body text.\nConclusion'), false);

const authorDateReferenceLines = `Example, A., Builder, B. L., Checker, C. C., & Debugger, D. (2015). Testing parser behavior with synthetic references: Pitfalls and promises. Journal of Fixture Studies, 45, 1121-1136. https://doi.org/10.1000/fixture.2015.001
Sampleton, K., Mock, S. K., Placeholder, J. N., & Trial, B. N. (2021). Avoiding sensitive examples: Suggestions for parser regression tests. Synthetic Citation Quarterly. https://doi.org/10.1000/fixture.2021.002
Harness, N., & Runner, H. (2022, June). Detecting Citation Shapes Using Rule-Based Test Fixtures. In International Conference on Synthetic Documents (pp. 225-233). Example City: Fixture Publishing. https://doi.org/10.1000/fixture.2022.003`;
assert.strictEqual(looksLikeExtractedReferences(authorDateReferenceLines), true);
const authorDateRefs = extractReferencesFromText(authorDateReferenceLines);
assert.strictEqual(authorDateRefs.length, 3);
assert.ok(authorDateRefs[0].startsWith('Example, A.'));
assert.ok(authorDateRefs[1].startsWith('Sampleton'));
assert.ok(authorDateRefs[2].startsWith('Harness'));

const parenthesizedYearMetadata = extractReferenceMetadata('Fixture, C. J., Example, L. A., Pattern, J., Mock, E., Trial, J. K., Case, S. E., ... & Sample, G. C. (2007). The taxonomy of synthetic parser examples. Annu. Rev. Test Data, 28, 235-258. https://doi.org/10.1000/fixture.2007.004');
assert.strictEqual(parenthesizedYearMetadata.authors, 'Fixture, C. J., Example, L. A., Pattern, J., Mock, E., Trial, J. K., Case, S. E., ... & Sample, G. C.');
assert.strictEqual(parenthesizedYearMetadata.date, '2007');
assert.strictEqual(parenthesizedYearMetadata.title, 'The taxonomy of synthetic parser examples');
assert.strictEqual(parenthesizedYearMetadata.venue, 'Annu. Rev. Test Data');
assert.strictEqual(parenthesizedYearMetadata.volume, '28');
assert.strictEqual(parenthesizedYearMetadata.pages, '235-258');

const apaIssueMetadata = extractReferenceMetadata('Fixture, A. B., & Sample, C. D. (2025). A synthetic APA-like article. Journal of Fixture Records, 18(3), 44–59. https://doi.org/10.1000/fixture.2025.18');
assert.strictEqual(apaIssueMetadata.title, 'A synthetic APA-like article');
assert.strictEqual(apaIssueMetadata.venue, 'Journal of Fixture Records');
assert.strictEqual(apaIssueMetadata.volume, '18');
assert.strictEqual(apaIssueMetadata.issue, '3');
assert.strictEqual(apaIssueMetadata.pages, '44–59');

const apaOrganizationMetadata = extractReferenceMetadata('S.A.F.E. Fixture Alliance. (2026). S.A.F.E. by Design: Recommendations for synthetic parser evaluation (Task Force report). Fixture Alliance. https://example.invalid/fixture-report');
assert.strictEqual(apaOrganizationMetadata.authors, 'S.A.F.E. Fixture Alliance.');
assert.strictEqual(apaOrganizationMetadata.title, 'S.A.F.E. by Design: Recommendations for synthetic parser evaluation');
assert.strictEqual(apaOrganizationMetadata.venue, 'Fixture Alliance');

const apaAbbreviationMetadata = extractReferenceMetadata('Fixture, A., & Sample, B. (2025). Comparing guided vs. non-guided synthetic parsers [Preprint]. Fixture Archive. https://doi.org/10.1000/fixture.2025.99');
assert.strictEqual(apaAbbreviationMetadata.title, 'Comparing guided vs. non-guided synthetic parsers');
assert.strictEqual(apaAbbreviationMetadata.venue, 'Fixture Archive');

const apaEditedBookMetadata = extractReferenceMetadata('Fixture, A. (2024). A synthetic chapter. In B. Sample & C. Harness (Eds.), Handbook of Fixture Parsing (pp. 20–31). Fixture Press.');
assert.strictEqual(apaEditedBookMetadata.title, 'A synthetic chapter');
assert.ok(apaEditedBookMetadata.venue.includes('Handbook of Fixture Parsing'));
assert.strictEqual(apaEditedBookMetadata.pages, '20–31');

const mixedStyleReferenceLines = `Fixture, A. B. (2025). A synthetic APA entry. Journal of Fixture Records, 2(1), 1-9.
[2] B. Sample and C. Harness, “A synthetic IEEE entry,” Journal of Parser Fixtures, vol. 3, no. 2, pp. 10-20, 2026.
Example Research Group. (2024). A second synthetic organizational entry. Fixture Press.`;
const mixedStyleRefs = extractReferencesFromText(mixedStyleReferenceLines);
assert.strictEqual(mixedStyleRefs.length, 3);
assert.strictEqual(extractReferenceMetadata(mixedStyleRefs[0]).venue, 'Journal of Fixture Records');
assert.strictEqual(extractReferenceMetadata(mixedStyleRefs[1]).venue, 'Journal of Parser Fixtures');
assert.strictEqual(extractReferenceMetadata(mixedStyleRefs[2]).authors, 'Example Research Group.');

const extractedMetadata = extractReferenceMetadata('[8] Morgan Tester and Riley Example. 2025. Calibrating Widget Classifiers in the Age of Synthetic Data. ACM Trans. Test. Eval. 25, 3, Article 26 (June 2025), 9 pages. doi:10.1000/acm.test.2025.26');
assert.strictEqual(extractedMetadata.authors, 'Morgan Tester and Riley Example');
assert.strictEqual(extractedMetadata.date, '2025');
assert.strictEqual(extractedMetadata.title, 'Calibrating Widget Classifiers in the Age of Synthetic Data');
assert.ok(extractedMetadata.venue.includes('ACM Trans'));

const twoWordTitleMetadata = extractReferenceMetadata('[20] Jordan Fixture. 2006. Algorithmic Reasoning. Commun. Fixtures 49, 3 (2006), 33–35. doi:10.1000/fixture.2006.20');
assert.strictEqual(twoWordTitleMetadata.title, 'Algorithmic Reasoning');
assert.strictEqual(twoWordTitleMetadata.venue, 'Commun. Fixtures');
assert.strictEqual(twoWordTitleMetadata.volume, '49');
assert.strictEqual(twoWordTitleMetadata.issue, '3');
assert.strictEqual(twoWordTitleMetadata.pages, '33–35');

const omittedVenueMetadata = extractReferenceMetadata('[2] Avery Fixture, Blair Sample, and Casey Harness. 2026. Evaluating Synthetic Citation Parsers. 10, 1 (2026), 29.');
assert.strictEqual(omittedVenueMetadata.title, 'Evaluating Synthetic Citation Parsers');
assert.strictEqual(omittedVenueMetadata.venue, '');
assert.strictEqual(omittedVenueMetadata.volume, '10');
assert.strictEqual(omittedVenueMetadata.issue, '1');
assert.strictEqual(omittedVenueMetadata.pages, '29');

const editedBookChapterMetadata = extractReferenceMetadata('[10] Avery Fixture and Blair Sample. 2011. Developing reliable synthetic parsers. In Handbook of Research on Structured Test Records. Fixture Press, 58–64.');
assert.strictEqual(editedBookChapterMetadata.title, 'Developing reliable synthetic parsers');
assert.strictEqual(editedBookChapterMetadata.venue, 'Handbook of Research on Structured Test Records');
assert.strictEqual(editedBookChapterMetadata.pages, '58–64');

const publisherWithPagesMetadata = extractReferenceMetadata('[4] Avery Fixture, Blair Sample, and Casey Harness. 2026. Testing a Fixture-based Metadata Assessment Rubric. Association for the Advancement of Synthetic Education (AASE), 3833–3840.');
assert.strictEqual(publisherWithPagesMetadata.title, 'Testing a Fixture-based Metadata Assessment Rubric');
assert.strictEqual(publisherWithPagesMetadata.venue, 'Association for the Advancement of Synthetic Education (AASE)');
assert.strictEqual(publisherWithPagesMetadata.pages, '3833–3840');

const embeddedTitleQuoteMetadata = extractReferenceMetadata('[1] Avery Fixture. 2010. Why “Fixtures” Matter: A Framework for Reliable Parser Evaluation. Review of Synthetic Systems 14, 2 (2010), 105–112. doi:10.1000/fixture.2010.001');
assert.strictEqual(embeddedTitleQuoteMetadata.authors, 'Avery Fixture');
assert.strictEqual(embeddedTitleQuoteMetadata.title, 'Why “Fixtures” Matter: A Framework for Reliable Parser Evaluation');
assert.strictEqual(embeddedTitleQuoteMetadata.venue, 'Review of Synthetic Systems');
assert.strictEqual(embeddedTitleQuoteMetadata.volume, '14');
assert.strictEqual(embeddedTitleQuoteMetadata.issue, '2');
assert.strictEqual(embeddedTitleQuoteMetadata.pages, '105–112');

const ieeeProceedingsMetadata = extractReferenceMetadata('[2] A. Fixture, B. Parser, C. Harness, D. Runner, and E. Example, “Using synthetic records for testing citation parsers,” in Proc. 21st Example Conf. on Document Testing, pp. 1–3, 2021, doi: 10.1000/ieee.fixture.2021.002.');
assert.strictEqual(ieeeProceedingsMetadata.authors, 'A. Fixture, B. Parser, C. Harness, D. Runner, and E. Example');
assert.strictEqual(ieeeProceedingsMetadata.date, '2021');
assert.strictEqual(ieeeProceedingsMetadata.title, 'Using synthetic records for testing citation parsers');
assert.strictEqual(ieeeProceedingsMetadata.venue, 'Proc. 21st Example Conf. on Document Testing');
assert.strictEqual(ieeeProceedingsMetadata.pages, '1–3');

const yearLeadingConferenceMetadata = extractReferenceMetadata('[1] D. Fixture and B. Example, "Testing Venue Names That Contain Years," in Proceedings of the 2020 Conference on Synthetic Parser Systems (SPS \'20), Example City, TS, USA, 2020.');
assert.strictEqual(yearLeadingConferenceMetadata.venue, 'Proceedings of the 2020 Conference on Synthetic Parser Systems (SPS \'20)');

const symposiumWithLocationMetadata = extractReferenceMetadata('[3] R. Sample, H. W. Pattern, L. Mock and C. Harness, "Designing Synthetic Citations for Parser Regression Tests," in Proceedings of the Ninth Symposium on Fixture-Based Metadata Evaluation (FBME-19), Example City, TS, USA, 2019.');
assert.strictEqual(symposiumWithLocationMetadata.venue, 'Proceedings of the Ninth Symposium on Fixture-Based Metadata Evaluation (FBME-19)');

const yearLeadingWorkshopMetadata = extractReferenceMetadata('[4] S. Tester, T. Placeholder, S. Runner and R. Checker, "It’s a Fixture After All – Parsing Structured Test Records," in 2019 Example Blocks and Boundaries Workshop (EB&B), Sampleton, TS, USA, 2019.');
assert.strictEqual(yearLeadingWorkshopMetadata.venue, '2019 Example Blocks and Boundaries Workshop (EB&B)');

const ieeeJournalMetadata = extractReferenceMetadata('[3] Y. Example, S. Fixture, and R. Parser, “Teaching and Learning to Construct Data-Based Fixtures Using Sample Cards as the First Introduction to Parser Testing,” Journal of Synthetic Evaluation, vol. 23, no. 1, 2024, doi: 10.1000/jse.v23i1.450.');
assert.strictEqual(ieeeJournalMetadata.authors, 'Y. Example, S. Fixture, and R. Parser');
assert.strictEqual(ieeeJournalMetadata.date, '2024');
assert.strictEqual(ieeeJournalMetadata.title, 'Teaching and Learning to Construct Data-Based Fixtures Using Sample Cards as the First Introduction to Parser Testing');
assert.strictEqual(ieeeJournalMetadata.venue, 'Journal of Synthetic Evaluation');
assert.strictEqual(ieeeJournalMetadata.volume, '23');
assert.strictEqual(ieeeJournalMetadata.issue, '1');

const ieeeSinglePageMetadata = extractReferenceMetadata('[9] A. Sample, M. Placeholder, and V. Trial, “Using the example card game as a measurable parser task in a collaborative synthetic test space,” Fixture Learning Research – Examples, vol. 1, no. 2, p. 45, 2025, doi: 10.1000/h5d47t93.');
assert.strictEqual(ieeeSinglePageMetadata.title, 'Using the example card game as a measurable parser task in a collaborative synthetic test space');
assert.strictEqual(ieeeSinglePageMetadata.venue, 'Fixture Learning Research – Examples');
assert.strictEqual(ieeeSinglePageMetadata.volume, '1');
assert.strictEqual(ieeeSinglePageMetadata.issue, '2');
assert.strictEqual(ieeeSinglePageMetadata.pages, '45');

const colonTitleMetadata = extractReferenceMetadata('[5] Avery Pattern, Blair Harness, Casey Fixture, Drew Runner, Emery Sample, and Finley Mock. 2017. Changing a Parser’s Way of Thinking: Testing Structured Metadata Through Synthetic Citations. Journal of Synthetic Evaluation 87 (2017), 834 – 860. doi:10.1000/fixture.2017.005');
assert.strictEqual(colonTitleMetadata.title, 'Changing a Parser’s Way of Thinking: Testing Structured Metadata Through Synthetic Citations');
assert.ok(!colonTitleMetadata.title.includes('Avery Pattern'));
assert.strictEqual(colonTitleMetadata.venue, 'Journal of Synthetic Evaluation');
assert.strictEqual(colonTitleMetadata.volume, '87');
assert.strictEqual(colonTitleMetadata.pages, '834 – 860');

const issueMetadata = extractReferenceMetadata('[6] Casey Metric and Drew Parser. 2013. Widget Reasoning in K–12: A Review of the Synthetic Field. Journal of Parser Studies 42, 1 (2013), 38–43. arXiv:https://doi.org/10.1000/parser.2013.42 doi:10.1000/parser.2013.42');
assert.strictEqual(issueMetadata.venue, 'Journal of Parser Studies');
assert.strictEqual(issueMetadata.volume, '42');
assert.strictEqual(issueMetadata.issue, '1');
assert.strictEqual(issueMetadata.pages, '38–43');

const proceedingsPageMetadata = extractReferenceMetadata('[5] Irene Fixture, Safinah Sample, Helen Harness, Daniella Debug, and Cynthia Checker. 2021. Developing Synthetic Test Fixtures. In Proceedings of the 52nd ACM Technical Symposium on Parser Evaluation (Virtual Event, USA) (TEST ’21). Association for Computing Machinery, New York, NY, USA, 191–197. https://doi.org/10.1000/acm.fixture.2021.005');
assert.ok(proceedingsPageMetadata.venue.includes('Proceedings of the 52nd ACM Technical Symposium'));
assert.strictEqual(proceedingsPageMetadata.pages, '191–197');

const processesTitleMetadata = extractReferenceMetadata('[4] Riley Fixture. 2024. Experiences Using Research Processes in an Undergraduate Theory Course. In Proceedings of the 55th ACM Technical Symposium on Synthetic Systems V. 1 (TEST 2024), March 20–23, 2024, Sampleton, TS, USA. ACM, New York, NY, USA, 7 pages. 310–316 https://doi.org/10.1000/acm.fixture.2024.004.');
assert.strictEqual(processesTitleMetadata.title, 'Experiences Using Research Processes in an Undergraduate Theory Course');
assert.strictEqual(processesTitleMetadata.venue, 'Proceedings of the 55th ACM Technical Symposium on Synthetic Systems V. 1 (TEST 2024)');
assert.strictEqual(processesTitleMetadata.pages, '310–316');

const monthIssueMetadata = extractReferenceMetadata('[6] Phoebe Fixture, Jessica Example, Galit Sample, Randi Harness, and Cynthia Checker. 2020. Zedbot: Designing a Conversational Fixture for Users to Explore Parser Concepts. Proceedings of the Example Conference on Synthetic Intelligence 34, 09 (Apr. 2020), 13381–13388. https://doi.org/10.1000/example.v34i09.7061');
assert.strictEqual(monthIssueMetadata.venue, 'Proceedings of the Example Conference on Synthetic Intelligence');
assert.strictEqual(monthIssueMetadata.volume, '34');
assert.strictEqual(monthIssueMetadata.issue, '09');
assert.strictEqual(monthIssueMetadata.pages, '13381–13388');

const trailingYearConferenceMetadata = extractReferenceMetadata('[8] Avery Fixture, Blair Sample, and Casey Harness. Comparing synthetic parser progressions for fixture classes. In Proceedings of the 2019 Conference on Synthetic Citation Testing, TEST ’19, pages 395–401, Sampleton, TS, USA, 2019. Association for Fixture Machinery.');
assert.strictEqual(trailingYearConferenceMetadata.authors, 'Avery Fixture, Blair Sample, and Casey Harness');
assert.strictEqual(trailingYearConferenceMetadata.date, '2019');
assert.strictEqual(trailingYearConferenceMetadata.title, 'Comparing synthetic parser progressions for fixture classes');
assert.strictEqual(trailingYearConferenceMetadata.venue, 'Proceedings of the 2019 Conference on Synthetic Citation Testing, TEST ’19');
assert.strictEqual(trailingYearConferenceMetadata.pages, '395–401');

const ordinalConferenceMetadata = extractReferenceMetadata('Avery Fixture, Blair Sample, and Casey Harness. Evaluating synthetic mobile parser interfaces. In 22nd International conference on fixture interaction with sample devices and services, pp. 1–12, 2020.');
assert.strictEqual(ordinalConferenceMetadata.title, 'Evaluating synthetic mobile parser interfaces');
assert.strictEqual(ordinalConferenceMetadata.venue, '22nd International conference on fixture interaction with sample devices and services');
assert.strictEqual(ordinalConferenceMetadata.pages, '1–12');

const editedProceedingsMetadata = extractReferenceMetadata('Avery Fixture, Blair Sample, and Casey Harness. Grounding synthetic parser evaluations with structured records. In Drew Editor, Emery Sample, and Finley Mock (eds.), Findings of the Association for Fixture Parsing: TEST 2025, pp. 12807–12833, Sampleton, TS, July 2025. Association for Fixture Parsing.');
assert.strictEqual(editedProceedingsMetadata.title, 'Grounding synthetic parser evaluations with structured records');
assert.strictEqual(editedProceedingsMetadata.venue, 'Findings of the Association for Fixture Parsing: TEST 2025');
assert.strictEqual(editedProceedingsMetadata.pages, '12807–12833');

const trailingYearArxivMetadata = extractReferenceMetadata('Avery Fixture, Blair Sample, Casey Harness, et al. Training synthetic parsers with structured preprint records. arXiv preprint arXiv:2603.01234, 2026.');
assert.strictEqual(trailingYearArxivMetadata.authors, 'Avery Fixture, Blair Sample, Casey Harness, et al.');
assert.strictEqual(trailingYearArxivMetadata.title, 'Training synthetic parsers with structured preprint records');
assert.strictEqual(trailingYearArxivMetadata.venue, 'arXiv');
assert.strictEqual(trailingYearArxivMetadata.date, '2026');

const trailingYearJournalMetadata = extractReferenceMetadata('[18] Avery Fixture, Blair Sample, and Casey Harness. Can synthetic records improve parser tests? Proceedings of the Fixture Intelligence Conference, 33(01):9795–9799, Jul. 2019.');
assert.strictEqual(trailingYearJournalMetadata.authors, 'Avery Fixture, Blair Sample, and Casey Harness');
assert.strictEqual(trailingYearJournalMetadata.date, '2019');
assert.strictEqual(trailingYearJournalMetadata.title, 'Can synthetic records improve parser tests?');
assert.strictEqual(trailingYearJournalMetadata.venue, 'Proceedings of the Fixture Intelligence Conference');
assert.strictEqual(trailingYearJournalMetadata.volume, '33');
assert.strictEqual(trailingYearJournalMetadata.issue, '01');
assert.strictEqual(trailingYearJournalMetadata.pages, '9795–9799');

const trailingYearJournalWithoutIssueMetadata = extractReferenceMetadata('Avery Fixture, Blair Sample, and Casey Harness. Aligning synthetic records with parser attention. Advances in Fixture Processing Systems, 37:1890–1918, 2024.');
assert.strictEqual(trailingYearJournalWithoutIssueMetadata.title, 'Aligning synthetic records with parser attention');
assert.strictEqual(trailingYearJournalWithoutIssueMetadata.venue, 'Advances in Fixture Processing Systems');
assert.strictEqual(trailingYearJournalWithoutIssueMetadata.volume, '37');
assert.strictEqual(trailingYearJournalWithoutIssueMetadata.issue, '');
assert.strictEqual(trailingYearJournalWithoutIssueMetadata.pages, '1890–1918');

const trailingYearEmbeddedQuoteMetadata = extractReferenceMetadata('[21] Avery Fixture, Blair Sample, and Casey Harness. "parser, can I test you?": Student perceptions of synthetic citation tools. In Proceedings of the Annual Fixture Interaction Conference, pages 305–313, Sampleton, TS, USA, 2021. Association for Fixture Machinery.');
assert.strictEqual(trailingYearEmbeddedQuoteMetadata.title, '"parser, can I test you?": Student perceptions of synthetic citation tools');
assert.strictEqual(trailingYearEmbeddedQuoteMetadata.venue, 'Proceedings of the Annual Fixture Interaction Conference');
assert.strictEqual(trailingYearEmbeddedQuoteMetadata.pages, '305–313');

const trailingYearProceedingsMetadata = extractReferenceMetadata('[7] Avery Fixture and Blair Sample. What is synthetic parser literacy? competencies and design considerations. In Proceedings of the 2020 Conference on Fixture Systems, TEST ’20, pages 1–16, Sampleton, TS, USA, 2020. Association for Fixture Machinery.');
assert.strictEqual(trailingYearProceedingsMetadata.title, 'What is synthetic parser literacy? competencies and design considerations');
assert.strictEqual(trailingYearProceedingsMetadata.venue, 'Proceedings of the 2020 Conference on Fixture Systems, TEST ’20');
assert.strictEqual(trailingYearProceedingsMetadata.pages, '1–16');

const scoredMatch = scoreCandidateMatch('Smith, J. and Doe, A. 2020. Title of a paper. Journal of Testing.', {
  title: 'Title of a paper',
  containerTitle: 'Journal of Testing',
  authors: 'Smith, Doe',
  year: 2020
});
assert.strictEqual(scoredMatch.confidence, 'high');
assert.ok(scoredMatch.evidence.some((line) => line.includes('Year matched: 2020')));

const exactFieldOverlapMatch = scoreCandidateMatch('[5] Avery Fixture and Blair Sample. 2023. Building Reliable Synthetic Citation Checks. Journal of Fixture Validation 68, 3 (2023), 423–434. doi:10.1000/fixture.2023.005', {
  title: 'Building Reliable Synthetic Citation Checks',
  containerTitle: 'Journal of Fixture Validation',
  authors: 'Avery Fixture, Blair Sample',
  year: 2024,
  volume: '68',
  issue: '3',
  pages: '423-434',
  doi: '10.1000/fixture.2023.005'
});
assert.ok(exactFieldOverlapMatch.evidence.includes('Author overlap: strong'));
assert.ok(exactFieldOverlapMatch.evidence.includes('Venue overlap: strong'));
assert.ok(exactFieldOverlapMatch.evidence.includes('Year mismatch: cited 2023, candidate 2024'));
assert.strictEqual(exactFieldOverlapMatch.confidence, 'high');

const abbreviatedAuthorMatch = scoreCandidateMatch('[5] Avery Fixture et al. 2021. Advancing Synthetic Parsers with Structured Records. Journal of Fixture Research 600 (2021), 70–74. https://doi.org/10.1000/fixture.2021.005.', {
  title: 'Advancing Synthetic Parsers with Structured Records',
  containerTitle: 'Journal of Fixture Research',
  authors: 'Avery Fixture, Blair Sample, Casey Harness, Drew Parser',
  year: 2021,
  volume: '600',
  pages: '70-74',
  doi: '10.1000/fixture.2021.005'
});
assert.strictEqual(abbreviatedAuthorMatch.confidence, 'medium');
assert.strictEqual(abbreviatedAuthorMatch.details.hasAbbreviatedAuthorList, true);
assert.ok(abbreviatedAuthorMatch.evidence.some((line) => line.includes('et al.')));
assert.ok(abbreviatedAuthorMatch.evidence.some((line) => line.includes('DOI exactly matched')));

const publicationDetailMatch = scoreCandidateMatch('[6] Casey Metric and Drew Parser. 2013. Widget Reasoning in K–12: A Review of the Synthetic Field. Journal of Parser Studies 42, 1 (2013), 38–43.', {
  title: 'Widget Reasoning in K–12',
  containerTitle: 'Journal of Parser Studies',
  authors: 'Casey Metric, Drew Parser',
  year: 2013,
  volume: '42',
  issue: '1',
  pages: '38-43'
});
assert.ok(publicationDetailMatch.evidence.some((line) => line.includes('Volume matched: 42')));
assert.ok(publicationDetailMatch.evidence.some((line) => line.includes('Issue matched: 1')));
assert.ok(publicationDetailMatch.evidence.some((line) => line.includes('Pages matched: 38-43')));

const genericContainedTitleMatch = scoreCandidateMatch('[1] A. Fixture, B. Parser, and C. Harness, “Data, Trees, and Forests – Decision Tree Learning in K–12 Education,” in Proc. 3rd Teaching Machine Learning and Artificial Intelligence Workshop, vol. 207, pp. 37–41, 2023.', {
  title: 'Decision Trees',
  containerTitle: 'Machine Learning and Artificial Intelligence',
  authors: 'Unrelated Author',
  year: 2023,
  pages: '73-87',
  doi: '10.1000/unrelated-decision-trees'
});
assert.strictEqual(genericContainedTitleMatch.confidence, 'low');
assert.ok(genericContainedTitleMatch.score < 0.75);

const expandedContainedTitleMatch = scoreCandidateMatch('[1] A. Fixture, B. Parser, and C. Harness, “Data, Trees, and Forests – Decision Tree Learning in K–12 Education,” in Proc. 3rd Teaching Machine Learning and Artificial Intelligence Workshop, vol. 207, pp. 37–41, 2023.', {
  title: 'Decision Trees and Random Forests',
  containerTitle: 'Linear Algebra With Machine Learning and Data',
  authors: 'Unrelated Author',
  year: 2023,
  pages: '209-236',
  doi: '10.1000/unrelated-random-forests'
});
assert.strictEqual(expandedContainedTitleMatch.confidence, 'low');

const mismatchMatch = scoreCandidateMatch('Smith, J. Title of a paper. Journal of Testing 2020.', {
  title: 'Completely unrelated research methods',
  containerTitle: 'Other Journal',
  authors: 'Johnson',
  year: 2023
});
assert.strictEqual(mismatchMatch.confidence, 'low');
assert.ok(mismatchMatch.evidence.some((line) => line.includes('Year mismatch')));

const rankedCandidates = rankCandidates('Smith, J. and Doe, A. 2020. Title of a paper. Journal of Testing.', [
  { title: 'Unrelated work', containerTitle: 'Other Journal', authors: 'Someone', year: 2018, doi: '10.1000/nope' },
  { title: 'Title of a paper', containerTitle: 'Journal of Testing', authors: 'Smith, Doe', year: 2020, doi: '10.1000/match' }
]);
assert.strictEqual(rankedCandidates[0].doi, '10.1000/match');

const normalizedWork = normalizeCrossrefWork({
  DOI: '10.1000/ABC.',
  title: ['Normalized title'],
  author: [{ given: 'Jane', family: 'Smith' }],
  'container-title': ['Journal of Testing'],
  issued: { 'date-parts': [[2022, 5, 1]] },
  volume: '12',
  issue: '3',
  page: '45-67'
});
assert.strictEqual(normalizedWork.doi, '10.1000/abc');
assert.strictEqual(normalizedWork.title, 'Normalized title');
assert.strictEqual(normalizedWork.authors, 'Jane Smith');
assert.strictEqual(normalizedWork.year, 2022);
assert.strictEqual(normalizedWork.volume, '12');
assert.strictEqual(normalizedWork.issue, '3');
assert.strictEqual(normalizedWork.pages, '45-67');
assert.strictEqual(normalizeDoi('10.1000/ABC.'), '10.1000/abc');

const subtitleAndFullAuthorsWork = normalizeCrossrefWork({
  DOI: '10.1000/full-metadata',
  title: ['FixtureAI'],
  subtitle: ['Evaluating Complete Synthetic Metadata'],
  author: Array.from({ length: 9 }, (unused, index) => ({
    given: `Author${index + 1}`,
    family: `Fixture${index + 1}`
  }))
});
assert.strictEqual(subtitleAndFullAuthorsWork.title, 'FixtureAI: Evaluating Complete Synthetic Metadata');
assert.ok(subtitleAndFullAuthorsWork.authors.includes('Author9 Fixture9'));
assert.strictEqual(subtitleAndFullAuthorsWork.authors.split(', ').length, 9);

const printYearWork = normalizeCrossrefWork({
  DOI: '10.1000/print-year',
  title: ['Choosing the Print Year for a Synthetic Online-First Article'],
  issued: { 'date-parts': [[2014, 10, 8]] },
  published: { 'date-parts': [[2014, 10, 8]] },
  'published-online': { 'date-parts': [[2014, 10, 8]] },
  'published-print': { 'date-parts': [[2015, 5]] },
  volume: '45',
  page: '1121-1136'
});
assert.strictEqual(printYearWork.year, 2015);

const issuePrintYearWork = normalizeCrossrefWork({
  DOI: '10.1000/issue-print-year',
  title: ['Choosing the Print Year from a Synthetic Journal Issue'],
  issued: { 'date-parts': [[2014, 10, 8]] },
  'journal-issue': { 'published-print': { 'date-parts': [[2015, 5]] } }
});
assert.strictEqual(issuePrintYearWork.year, 2015);

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
assert.strictEqual(confidenceForLookupError({ status: 404 }), 'low');
assert.strictEqual(confidenceForLookupError({ status: 429 }), 'medium');
assert.strictEqual(confidenceForLookupError(new Error('network timeout')), 'medium');

async function runAsyncTests() {
  await assert.rejects(
    fetchWithTimeout(
      'https://example.invalid/hanging-request',
      {},
      5,
      'Synthetic API',
      async () => new Promise(() => {})
    ),
    (error) => error.code === 'ETIMEDOUT' && error.message.includes('Synthetic API request timed out')
  );

  assert.strictEqual(
    shouldSearchArxiv('[2] Taylor Fixture. [n. d.]. Synthetic project page. Retrieved August 1, 2026 from https://example.invalid/project'),
    false
  );
  assert.strictEqual(
    shouldSearchArxiv('[2] Taylor Fixture. 2026. A Synthetic Study of Parser Reliability.'),
    true
  );
  assert.strictEqual(
    shouldSearchArxiv('[4] Taylor Fixture and Morgan Sample. 2026. A Published Synthetic Study. Fixture Education Association, 101–108.'),
    false
  );
assert.strictEqual(isRetriableArxivStatus(429), false);
assert.strictEqual(isRetriableArxivStatus(503), true);
assert.strictEqual(isViableSearchCandidate({ match: { score: 0 } }), false);
assert.strictEqual(isViableSearchCandidate({ match: { score: 0.15 } }), true);
  let webArxivFallbackCalls = 0;
  const webReferenceMatch = await analyzeReference('[2] Taylor Fixture. [n. d.]. Synthetic project page. Retrieved August 1, 2026 from https://example.invalid/project', {
    searchCrossrefCandidates: async () => [],
    searchArxivCandidates: async () => {
      webArxivFallbackCalls += 1;
      return [];
    }
  });
  assert.strictEqual(webArxivFallbackCalls, 0);
  assert.ok(webReferenceMatch.summary.includes('arXiv fallback was not applicable'));
  let publishedArxivFallbackCalls = 0;
  await analyzeReference('[4] Taylor Fixture and Morgan Sample. 2026. A Published Synthetic Study. Fixture Education Association, 101–108.', {
    searchCrossrefCandidates: async () => [],
    searchArxivCandidates: async () => {
      publishedArxivFallbackCalls += 1;
      return [];
    }
  });
  assert.strictEqual(publishedArxivFallbackCalls, 0);
  const unrelatedCandidateMatch = await analyzeReference('[4] Avery Fixture, Blair Sample, and Casey Harness. 2026. Testing a Fixture-based Metadata Assessment Rubric. Association for the Advancement of Synthetic Education (AASE), 3833–3840.', {
    searchCrossrefCandidates: async () => [{
      title: 'An Unrelated Study of Different Systems',
      containerTitle: 'Journal of Unrelated Examples',
      authors: 'Morgan Placeholder',
      year: 2018,
      doi: '10.1000/unrelated.fixture'
    }],
    searchArxivCandidates: async () => {
      throw new Error('Published citation should not use arXiv fallback');
    }
  });
  assert.strictEqual(unrelatedCandidateMatch.source, null);
  assert.strictEqual(unrelatedCandidateMatch.doi, null);
  assert.strictEqual(unrelatedCandidateMatch.metadata.matched.title, '');

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

  const originalArxivFetch = global.fetch;
  let arxivBatchCalls = 0;
  let arxivBatchUrl = '';
  global.fetch = async (url) => {
    arxivBatchCalls += 1;
    arxivBatchUrl = String(url);
    return {
      ok: true,
      text: async () => syntheticArxivFeed
    };
  };
  try {
    const identifiers = [
      extractArxivIdentifier('arXiv:2601.12345v2'),
      extractArxivIdentifier('arXiv:2601.99999')
    ];
    const batched = await fetchArxivEntriesByIds(identifiers);
    assert.strictEqual(arxivBatchCalls, 1);
    assert.ok(new URL(arxivBatchUrl).searchParams.get('id_list').includes(','));
    assert.strictEqual(batched.get('2601.12345v2').title, syntheticArxivCandidate.title);
    assert.strictEqual(batched.get('2601.99999'), null);
    await fetchArxivEntriesByIds(identifiers);
    assert.strictEqual(arxivBatchCalls, 1);
  } finally {
    global.fetch = originalArxivFetch;
  }

  const directArxivCandidates = new Map([['2601.12345v2', syntheticArxivCandidate]]);
  const arxivMatch = await analyzeReference('[4] Jordan Fixture and Riley Sample. 2026. Reliable Fixtures & Structured Parser Tests. arXiv:2601.12345v2 [cs.EX] https://arxiv.org/abs/2601.12345v2', {
    arxivCandidates: directArxivCandidates
  });
  assert.strictEqual(arxivMatch.doi, '10.48550/arxiv.2601.12345');
  assert.strictEqual(arxivMatch.source, 'arxiv');
  assert.strictEqual(arxivMatch.confidence, 'high');
  assert.ok(arxivMatch.summary.includes('resolved'));
  assert.ok(arxivMatch.evidence.some((line) => line.includes('arXiv identifier matched')));

  const versionMismatchMatch = await analyzeReference('[4] Jordan Fixture and Riley Sample. 2026. Reliable Fixtures & Structured Parser Tests. arXiv:2601.12345v3', {
    arxivCandidates: new Map([['2601.12345v3', syntheticArxivCandidate]])
  });
  assert.strictEqual(versionMismatchMatch.confidence, 'medium');
  assert.ok(versionMismatchMatch.evidence.some((line) => line.includes('version mismatch')));

  const missingArxivMatch = await analyzeReference('[4] Jordan Fixture. 2026. Missing Synthetic Preprint. arXiv:2601.99999', {
    arxivCandidates: new Map([['2601.99999', null]])
  });
  assert.strictEqual(missingArxivMatch.confidence, 'low');
  assert.ok(missingArxivMatch.summary.includes('was not found'));

  let arxivFallbackCalls = 0;
  const fallbackArxivMatch = await analyzeReference('[8] Jordan Fixture and Riley Sample. 2026. Reliable Fixtures & Structured Parser Tests.', {
    searchCrossrefCandidates: async () => [],
    searchArxivCandidates: async () => {
      arxivFallbackCalls += 1;
      return [syntheticArxivCandidate];
    }
  });
  assert.strictEqual(arxivFallbackCalls, 1);
  assert.strictEqual(fallbackArxivMatch.source, 'arxiv');
  assert.strictEqual(fallbackArxivMatch.confidence, 'medium');
  assert.ok(fallbackArxivMatch.summary.includes('Crossref had no viable match'));

  let skippedArxivFallbackCalls = 0;
  const crossrefPreferredMatch = await analyzeReference('[8] Jordan Fixture and Riley Sample. 2026. Reliable Fixtures & Structured Parser Tests. Journal of Synthetic Records.', {
    searchCrossrefCandidates: async () => [{
      title: 'Reliable Fixtures & Structured Parser Tests',
      containerTitle: 'Journal of Synthetic Records',
      authors: 'Jordan Fixture, Riley Sample',
      year: 2026,
      doi: '10.1000/fixture.2026.12345'
    }],
    searchArxivCandidates: async () => {
      skippedArxivFallbackCalls += 1;
      return [syntheticArxivCandidate];
    }
  });
  assert.strictEqual(skippedArxivFallbackCalls, 0);
  assert.strictEqual(crossrefPreferredMatch.source, 'crossref');
  assert.strictEqual(crossrefPreferredMatch.confidence, 'medium');

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      message: {
        items: [{
          DOI: '10.1000/missing-source-doi',
          title: ['A Perfect Synthetic Candidate'],
          author: [
            { given: 'Alice', family: 'Fixture' },
            { given: 'Bob', family: 'Harness' }
          ],
          'container-title': ['Journal of Missing DOI Tests'],
          issued: { 'date-parts': [[2024]] },
          volume: '12',
          issue: '3',
          page: '45-67'
        }]
      }
    })
  });

  try {
    const noSourceDoiMatch = await analyzeReference('[4] Alice Fixture and Bob Harness. 2024. A Perfect Synthetic Candidate. Journal of Missing DOI Tests 12, 3 (2024), 45-67.');
    assert.strictEqual(noSourceDoiMatch.confidence, 'medium');
    assert.strictEqual(noSourceDoiMatch.doi, '10.1000/missing-source-doi');
  } finally {
    global.fetch = originalFetch;
  }
}

runAsyncTests()
  .then(() => console.log('header regression test passed'))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
