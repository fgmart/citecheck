const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PORT = process.env.PORT || 3000;
const uploadsDir = path.join(__dirname, 'uploads');
const ENGINE_VERSION = 'citecheck-v2.2.3';
const DEBUG_PARSER = process.env.DEBUG_PARSER === 'true';
const CROSSREF_MAILTO = process.env.CROSSREF_MAILTO || '';
const CROSSREF_CONCURRENCY = Number(process.env.CROSSREF_CONCURRENCY || 1);
const CROSSREF_RETRIES = Number(process.env.CROSSREF_RETRIES || 4);
const CROSSREF_MIN_INTERVAL_MS = Number(process.env.CROSSREF_MIN_INTERVAL_MS || 1500);
const CITECHECK_MAX_REFERENCES = Number(process.env.CITECHECK_MAX_REFERENCES || 100);
let nextCrossrefRequestAt = 0;
fs.mkdirSync(uploadsDir, { recursive: true });

function debugLog(message, detail) {
  if (!DEBUG_PARSER) return;
  if (detail !== undefined) {
    console.log(`[parser] ${message}`, detail);
  } else {
    console.log(`[parser] ${message}`);
  }
}

function normalizeText(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanExtractedText(text) {
  return text
    .replace(/\r/g, '')
    .replace(/([a-zA-Z])\n(?=[a-zA-Z])/g, '$1 ')
    .replace(/\n{2,}/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function stripPageHeaders(text) {
  const lines = text.split(/\n/).map((line) => line.trim()).filter(Boolean);
  const referenceHeadingIndex = lines.findIndex((line) => /^references$|^bibliography$/i.test(line));

  if (referenceHeadingIndex < 0) {
    return lines.join('\n');
  }

  return lines.slice(referenceHeadingIndex + 1).join('\n');
}

function reorderTextForColumns(text) {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const reordered = [];

  for (const paragraph of paragraphs) {
    const lines = paragraph.split(/\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length <= 2) {
      reordered.push(lines.join(' '));
      continue;
    }

    const firstHalf = lines.slice(0, Math.ceil(lines.length / 2));
    const secondHalf = lines.slice(Math.ceil(lines.length / 2));
    const merged = [];
    const max = Math.max(firstHalf.length, secondHalf.length);
    for (let i = 0; i < max; i += 1) {
      if (firstHalf[i]) merged.push(firstHalf[i]);
      if (secondHalf[i]) merged.push(secondHalf[i]);
    }
    reordered.push(merged.join(' '));
  }

  return reordered.join('\n\n');
}

function looksLikeExtractedReferences(text) {
  const markerLines = text
    .split(/\r?\n/)
    .filter((line) => /^(?:\[\d{1,3}\]|[1-9]\d{0,2}[.)])\s+/.test(line.trim()));
  return markerLines.length >= 3;
}

function extractReferencesFromText(text, debugSink = null) {
  const lines = text.split(/\r?\n/);
  const referenceHeadingIndex = lines.findIndex((line) => /^references$|^bibliography$/i.test(line.trim()));
  const sectionLines = referenceHeadingIndex >= 0 ? lines.slice(referenceHeadingIndex + 1) : lines;
  const sectionText = sectionLines.join('\n').trim();

  const emitDebug = (message, detail) => {
    debugLog(message, detail);
    if (debugSink) debugSink.push(typeof detail === 'undefined' ? message : `${message}: ${JSON.stringify(detail)}`);
  };

  emitDebug('raw section length', sectionText.length);
  emitDebug('reference heading index', referenceHeadingIndex);

  if (!sectionText) {
    emitDebug('no section text found');
    return [];
  }

  const doiRegex = /10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i;
  const lineBasedReferences = [];
  let currentLineReference = '';
  const sectionLinesForDebug = sectionText.split(/\r?\n/);

  for (const rawLine of sectionLinesForDebug) {
    const line = rawLine.trim();
    if (!line) {
      if (currentLineReference) {
        lineBasedReferences.push(currentLineReference.trim());
        currentLineReference = '';
      }
      continue;
    }

    const markerAtLineStart = /^(?:\[(?:\d{1,3})\]|(?:[1-9]\d{0,2})[.)])\s+/.test(line);
    if (markerAtLineStart) {
      if (currentLineReference) lineBasedReferences.push(currentLineReference.trim());
      currentLineReference = line;
    } else if (currentLineReference) {
      currentLineReference += ` ${line}`;
    } else {
      currentLineReference = line;
    }
  }

  if (currentLineReference) lineBasedReferences.push(currentLineReference.trim());

  emitDebug('line-based references', lineBasedReferences);

  if (lineBasedReferences.length > 1) {
    emitDebug('using line-based extraction');
    return lineBasedReferences.filter(Boolean).slice(0, CITECHECK_MAX_REFERENCES);
  }

  const markerRegex = /(?<!\S)(\[(?:\d{1,3})\]|(?:[1-9]\d{0,2})[.)])(?=\s+(?:[A-Za-z"'“]))/g;
  const matches = Array.from(sectionText.matchAll(markerRegex));

  emitDebug('marker regex matches', matches.map((match) => ({ index: match.index, value: match[0] })));

  if (matches.length > 0) {
    const starts = matches.map((match) => match.index);
    const references = [];

    for (let i = 0; i < starts.length; i += 1) {
      const start = starts[i];
      const end = i < starts.length - 1 ? starts[i + 1] : sectionText.length;
      let chunk = sectionText.slice(start, end).trim();

      const doiMatch = chunk.match(doiRegex);
      if (doiMatch) {
        const doiIndex = chunk.indexOf(doiMatch[0]);
        chunk = chunk.slice(0, doiIndex + doiMatch[0].length).trim();
      }

      if (chunk) references.push(chunk);
    }

    emitDebug('regex-based references', references);
    return references.filter(Boolean).slice(0, CITECHECK_MAX_REFERENCES);
  }

  const references = [];
  let current = '';

  for (const rawLine of sectionLines) {
    const line = rawLine.trim();
    if (!line) {
      if (current) {
        references.push(current.trim());
        current = '';
      }
      continue;
    }

    if (/^(abstract|introduction|conclusion|appendix|acknowledgments|data availability|funding)/i.test(line)) {
      break;
    } else if (current) {
      current += ` ${line}`;
    } else {
      current = line;
    }
  }

  if (current) references.push(current.trim());
  emitDebug('fallback references', references);
  return references.filter(Boolean).slice(0, CITECHECK_MAX_REFERENCES);
}

function inferReferenceType(reference) {
  const lower = reference.toLowerCase();
  if (lower.includes('doi:') || lower.includes('https://doi.org/')) return 'doi';
  if (lower.includes('arxiv')) return 'arxiv';
  if (lower.includes('journal') || lower.includes('proc') || lower.includes('transactions')) return 'article';
  return 'unknown';
}

function normalizeDoi(doi) {
  return doi ? doi.replace(/[.,;:]+$/g, '').toLowerCase() : null;
}

function extractDoi(reference) {
  const match = reference.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
  return match ? normalizeDoi(match[0]) : null;
}

function extractTitleCandidate(reference) {
  const withoutNumbers = reference.replace(/^(\[\d+\]|\d+[.)]\s*)/, '').trim();
  const withoutDoi = withoutNumbers.replace(/10\.\d{4,9}\/[\-._;()/:A-Z0-9]+/gi, '').trim();
  const withoutUrl = withoutDoi.replace(/https?:\/\/\S+/gi, '').trim();
  const year = extractYear(withoutUrl);
  const titleSource = year && withoutUrl.includes(String(year))
    ? withoutUrl.slice(withoutUrl.indexOf(String(year)) + String(year).length)
    : withoutUrl;
  const segments = titleSource
    .split(/\.\s*/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const titleCandidate = segments.find((segment) => {
    const words = segment.split(/\s+/).filter(Boolean);
    return words.length >= 3 && !/[,:;]/.test(segment) && !/(journal|proc|transactions|conference|press|springer|ieee|acm|arxiv|doi|https?)/i.test(segment);
  });

  return titleCandidate || withoutUrl.slice(0, 160);
}

function extractYear(reference) {
  const match = reference.match(/\b(19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

function cleanReferenceForMetadata(reference) {
  return reference
    .replace(/^(\[\d+\]|\d+[.)]\s*)/, '')
    .replace(/\barXiv:\S+/gi, '')
    .replace(/\bdoi:\s*10\.\d{4,9}\/[-._;()/:A-Z0-9]+/gi, '')
    .replace(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+/gi, '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractAuthorsCandidate(reference) {
  const cleaned = cleanReferenceForMetadata(reference);
  const year = extractYear(cleaned);
  const beforeYear = year ? cleaned.slice(0, cleaned.indexOf(String(year))).trim() : cleaned.split(/\.\s+/)[0] || '';
  return beforeYear.replace(/[.,;:\s]+$/g, '').slice(0, 240);
}

function extractVenueCandidate(reference) {
  const cleaned = cleanReferenceForMetadata(reference);
  const title = extractTitleCandidate(reference);
  let afterTitle = cleaned;
  const titleIndex = title ? cleaned.toLowerCase().indexOf(title.toLowerCase()) : -1;
  if (titleIndex >= 0) afterTitle = cleaned.slice(titleIndex + title.length);

  const venuePatterns = [
    /\b(?:In\s+)?(Proceedings[^.]+)\./i,
    /\b((?:ACM|IEEE|Journal|Computers?|Education|Educational|Interactive|Technology|Research|Review|Communications|Transactions|Conference|Proc\.)[^.]+)\./i
  ];

  for (const pattern of venuePatterns) {
    const match = afterTitle.match(pattern);
    if (match && match[1]) return match[1].replace(/^\s*In\s+/i, '').trim();
  }

  const segments = afterTitle
    .split(/\.\s*/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const venue = segments.find((segment) => /(journal|proc|proceedings|conference|transactions|education|review|communications|press|springer|ieee|acm|sage|wiley)/i.test(segment));
  return venue ? venue.slice(0, 240) : '';
}

function extractReferenceMetadata(reference) {
  return {
    authors: extractAuthorsCandidate(reference),
    date: extractYear(reference) ? String(extractYear(reference)) : '',
    title: extractTitleCandidate(reference),
    venue: extractVenueCandidate(reference)
  };
}

function candidateMetadata(candidate = {}) {
  return {
    authors: candidate.authors || '',
    date: candidate.year ? String(candidate.year) : '',
    title: candidate.title || '',
    venue: candidate.containerTitle || candidate.publisher || ''
  };
}

function tokenize(text) {
  return normalizeText(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function tokenOverlapScore(leftText, rightText) {
  const left = Array.from(new Set(tokenize(leftText)));
  const right = Array.from(new Set(tokenize(rightText)));
  if (!left.length || !right.length) return 0;

  const rightSet = new Set(right);
  const overlap = left.filter((token) => rightSet.has(token));
  return overlap.length / Math.max(1, Math.min(left.length, right.length));
}

function formatScoreLabel(score) {
  if (score >= 0.8) return 'strong';
  if (score >= 0.45) return 'medium';
  if (score > 0) return 'weak';
  return 'none';
}

function scoreCandidateMatch(reference, candidate = {}) {
  const referenceTitle = extractTitleCandidate(reference);
  const titleScore = candidate.title ? Math.max(tokenOverlapScore(referenceTitle, candidate.title), tokenOverlapScore(reference, candidate.title)) : 0;
  const venueScore = candidate.containerTitle ? tokenOverlapScore(reference, candidate.containerTitle) : 0;
  const authorScore = candidate.authors ? tokenOverlapScore(reference, candidate.authors) : 0;
  const referenceYear = extractYear(reference);
  const yearMatched = Boolean(candidate.year && referenceYear && candidate.year === referenceYear);
  const yearMismatched = Boolean(candidate.year && referenceYear && candidate.year !== referenceYear);
  const yearDistance = yearMismatched ? Math.abs(candidate.year - referenceYear) : 0;
  const severeYearMismatch = yearDistance > 1;
  const yearScore = yearMatched ? 1 : 0;
  const doiMatched = Boolean(candidate.doi && extractDoi(reference) && normalizeDoi(candidate.doi) === extractDoi(reference));
  const doiBonus = doiMatched ? 0.2 : 0;
  const yearPenalty = severeYearMismatch ? 0.35 : yearMismatched ? 0.15 : 0;
  const weakTitlePenalty = titleScore < 0.25 ? 0.15 : 0;
  const score = Math.max(0, Math.min(1, titleScore * 0.5 + authorScore * 0.2 + yearScore * 0.15 + venueScore * 0.1 + doiBonus - yearPenalty - weakTitlePenalty));

  let confidence = 'low';
  if (score >= 0.75 && titleScore >= 0.45) confidence = 'high';
  else if (score >= 0.4 && titleScore >= 0.25) confidence = 'medium';
  if (severeYearMismatch && !doiMatched) confidence = 'low';

  const evidence = [
    `Title overlap: ${formatScoreLabel(titleScore)}`,
    `Author overlap: ${formatScoreLabel(authorScore)}`,
    `Venue overlap: ${formatScoreLabel(venueScore)}`
  ];

  if (referenceYear && candidate.year) {
    evidence.push(yearMatched ? `Year matched: ${candidate.year}` : `Year mismatch: cited ${referenceYear}, candidate ${candidate.year}`);
  } else if (referenceYear) {
    evidence.push(`Cited year: ${referenceYear}; candidate year unavailable`);
  } else if (candidate.year) {
    evidence.push(`Candidate year: ${candidate.year}`);
  }

  if (doiMatched) evidence.push('DOI exactly matched');

  return {
    score,
    confidence,
    evidence,
    details: {
      titleScore,
      authorScore,
      venueScore,
      yearMatched,
      yearMismatched,
      severeYearMismatch,
      doiMatched
    }
  };
}

function getCrossrefYear(work = {}) {
  const dateSource = work.issued || work['published-print'] || work['published-online'] || work.created;
  const dateParts = dateSource && dateSource['date-parts'];
  return Array.isArray(dateParts) && Array.isArray(dateParts[0]) ? dateParts[0][0] : null;
}

function normalizeCrossrefWork(work = {}) {
  const authors = Array.isArray(work.author)
    ? work.author.map((author) => author.family || author.name || [author.given, author.family].filter(Boolean).join(' ')).filter(Boolean).slice(0, 8).join(', ')
    : '';

  return {
    source: 'crossref',
    doi: normalizeDoi(work.DOI || work.doi || ''),
    title: Array.isArray(work.title) ? work.title[0] : work.title || '',
    authors,
    containerTitle: Array.isArray(work['container-title']) ? work['container-title'][0] : work['container-title'] || '',
    year: getCrossrefYear(work),
    volume: work.volume || '',
    issue: work.issue || '',
    pages: work.page || '',
    publisher: work.publisher || '',
    url: work.URL || '',
    crossrefScore: typeof work.score === 'number' ? work.score : null
  };
}

function buildCrossrefUrl(pathname, params = {}) {
  const url = new URL(`https://api.crossref.org${pathname}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  });
  if (CROSSREF_MAILTO) url.searchParams.set('mailto', CROSSREF_MAILTO);
  return url.toString();
}

function isRetriableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function getRetryDelay(attempt, response) {
  const retryAfter = response && response.headers ? response.headers.get('retry-after') : null;
  const retryAfterSeconds = retryAfter && Number(retryAfter);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return retryAfterSeconds * 1000;
  }
  if (response && response.status === 429) {
    return 10000 * 2 ** attempt;
  }
  return 400 * 2 ** attempt;
}

async function waitForCrossrefSlot(now = Date.now()) {
  const scheduledAt = Math.max(now, nextCrossrefRequestAt);
  nextCrossrefRequestAt = scheduledAt + CROSSREF_MIN_INTERVAL_MS;
  const delay = scheduledAt - now;
  if (delay > 0) await sleep(delay);
}

async function fetchJson(url, options = {}) {
  const retries = options.retries ?? CROSSREF_RETRIES;
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let response = null;

    try {
      await waitForCrossrefSlot();
      response = await fetch(url, {
        headers: {
          'User-Agent': `Citecheck/2.1.4${CROSSREF_MAILTO ? ` (mailto:${CROSSREF_MAILTO})` : ''}`
        }
      });

      if (response.ok) return response.json();

      lastError = new Error(`Remote request failed with status ${response.status}`);
      if (!isRetriableStatus(response.status) || attempt === retries) break;
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
    }

    await sleep(getRetryDelay(attempt, response));
  }

  throw lastError || new Error('Remote request failed');
}

async function fetchCrossrefWorkByDoi(doi) {
  const data = await fetchJson(buildCrossrefUrl(`/works/${encodeURIComponent(doi)}`));
  return normalizeCrossrefWork(data.message || {});
}

async function searchCrossrefCandidates(reference, rows = 8) {
  const data = await fetchJson(buildCrossrefUrl('/works', {
    rows,
    'query.bibliographic': normalizeText(reference)
  }));
  const items = data.message && Array.isArray(data.message.items) ? data.message.items : [];
  return items.map(normalizeCrossrefWork).filter((candidate) => candidate.title || candidate.doi);
}

function rankCandidates(reference, candidates = []) {
  return candidates
    .map((candidate) => {
      const match = scoreCandidateMatch(reference, candidate);
      return { ...candidate, match };
    })
    .sort((left, right) => right.match.score - left.match.score);
}

function describeCandidate(candidate) {
  if (!candidate) return 'unknown candidate';
  const parts = [
    candidate.title || 'untitled work',
    candidate.year ? `(${candidate.year})` : '',
    candidate.doi ? `DOI ${candidate.doi}` : ''
  ].filter(Boolean);
  return parts.join(' ');
}

function describeLookupError(error) {
  return error && error.message ? error.message : 'unknown error';
}

async function analyzeReference(reference) {
  const doi = extractDoi(reference);
  const type = inferReferenceType(reference);
  const extractedMetadata = extractReferenceMetadata(reference);
  let confidence = 'low';
  let summary = 'No DOI detected. Best-effort verification will rely on author/title/journal matching.';
  let recommendations = ['Consider adding a DOI or a stable URL for the cited work.'];
  let evidence = [];
  let doiFound = null;
  let matchedMetadata = candidateMetadata();

  if (doi) {
    try {
      const candidate = await fetchCrossrefWorkByDoi(doi);
      const match = scoreCandidateMatch(reference, candidate);
      confidence = match.confidence;
      doiFound = candidate.doi || doi;
      matchedMetadata = candidateMetadata(candidate);
      summary = `DOI resolved in Crossref: ${describeCandidate(candidate)}.`;
      evidence = [
        `Crossref title: ${candidate.title || 'not available'}`,
        ...match.evidence
      ];
      if (candidate.authors) evidence.push(`Crossref authors: ${candidate.authors}`);
      if (candidate.containerTitle) evidence.push(`Crossref venue: ${candidate.containerTitle}`);
      recommendations = ['Confirm that the author list, title, and venue exactly match the source metadata.'];
      if (confidence === 'low') {
        recommendations.push('The metadata overlap was weak, so this reference should be reviewed manually.');
      }
    } catch (error) {
      confidence = 'medium';
      summary = `DOI ${doi} was detected, but the Crossref lookup failed: ${describeLookupError(error)}.`;
      evidence = [`Lookup error: ${describeLookupError(error)}`];
      recommendations = ['Check the DOI manually and confirm the citation fields against the authoritative record.'];
    }
  } else {
    try {
      const ranked = rankCandidates(reference, await searchCrossrefCandidates(reference));
      const best = ranked[0];
      const second = ranked[1];

      if (best) {
        confidence = best.match.confidence;
        doiFound = best.doi;
        matchedMetadata = candidateMetadata(best);
        summary = `No DOI was present in the citation. Best Crossref candidate: ${describeCandidate(best)}.`;
        recommendations = ['Add an explicit DOI or stable URL if available and verify the reference metadata.'];
        evidence = [
          `Crossref candidates reviewed: ${ranked.length}`,
          `Best score: ${best.match.score.toFixed(2)}`,
          ...best.match.evidence
        ];
        if (best.authors) evidence.push(`Candidate authors: ${best.authors}`);
        if (best.containerTitle) evidence.push(`Candidate venue: ${best.containerTitle}`);
        if (second) {
          const gap = best.match.score - second.match.score;
          evidence.push(`Next candidate score: ${second.match.score.toFixed(2)} (${describeCandidate(second)})`);
          if (gap < 0.12) {
            confidence = confidence === 'high' ? 'medium' : confidence;
            recommendations.push('The top Crossref candidates are close together, so this match should be reviewed manually.');
          }
        }
        if (confidence === 'low') {
          recommendations.push('The title/author/venue/year overlap was weak, so this reference should be reviewed manually.');
        }
      }
    } catch (error) {
      summary = `No DOI was detected and Crossref candidate search failed: ${describeLookupError(error)}.`;
      evidence = [`Lookup error: ${describeLookupError(error)}`];
      recommendations = ['Add a DOI or a stable URL and verify title, author, and venue details manually.'];
    }
  }

  return {
    reference,
    type,
    doi: doiFound || doi,
    confidence,
    metadata: {
      extracted: extractedMetadata,
      matched: matchedMetadata
    },
    summary,
    recommendations,
    evidence,
    status: 'checked'
  };
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

function parseMultipartBody(body, boundary) {
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const parts = [];
  let offset = body.indexOf(boundaryBuffer);

  while (offset !== -1) {
    offset += boundaryBuffer.length;
    if (body[offset] === 0x2d) break;
    if (body[offset] === 0x0d) offset += 2;

    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), offset);
    if (headerEnd === -1) break;

    const headerText = body.subarray(offset, headerEnd).toString('utf8');
    const contentStart = headerEnd + 4;
    const contentEnd = body.indexOf(boundaryBuffer, contentStart);
    const contentBuffer = contentEnd === -1
      ? body.subarray(contentStart)
      : body.subarray(contentStart, contentEnd - 2);

    parts.push({ headerText, contentBuffer });
    offset = contentEnd === -1 ? -1 : contentEnd;
  }

  return parts;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function extractPdfText(pdfPath) {
  const venvPython = path.join(__dirname, '.venv', 'bin', 'python');
  const scriptPath = path.join(__dirname, 'scripts', 'extract_pdf_text.py');
  const output = execFileSync(venvPython, [scriptPath, pdfPath], { encoding: 'utf8' });
  const cleaned = cleanExtractedText(output);
  const withoutHeaders = stripPageHeaders(cleaned);
  const reordered = looksLikeExtractedReferences(withoutHeaders)
    ? withoutHeaders
    : reorderTextForColumns(withoutHeaders);
  return {
    raw: output,
    cleaned,
    withoutHeaders,
    processed: reordered
  };
}

function buildAnalyzeResponse({ filename, extracted, references, engineVersion, debugRequested, debugOutput }) {
  const response = {
    filename,
    totalCharacters: extracted.processed.length,
    referencesFound: references.length,
    references,
    engineVersion
  };

  if (debugRequested) {
    response.debugOutput = debugOutput.join('\n');
    response.rawExtractedText = extracted.raw;
    response.cleanedExtractedText = extracted.cleaned;
    response.processedExtractedText = extracted.processed;
  } else {
    response.debugOutput = null;
    response.rawExtractedText = null;
    response.cleanedExtractedText = null;
    response.processedExtractedText = null;
  }

  return response;
}

function writeAnalyzeEvent(res, event, data = {}) {
  res.write(`${JSON.stringify({ event, ...data })}\n`);
}

async function handleAnalyze(req, res) {
  try {
    const body = await readRequestBody(req);
    const contentType = req.headers['content-type'] || '';
    const boundary = contentType.match(/boundary=(.+)$/i);

    if (!boundary) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing multipart boundary.' }));
      return;
    }

    const parts = parseMultipartBody(body, boundary[1]);
    const pdfPart = parts.find((part) => /name="pdf"/i.test(part.headerText));
    const debugRequested = parts.some((part) => /name="debug"/i.test(part.headerText));

    if (!pdfPart) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No PDF part found in upload.' }));
      return;
    }

    const disposition = pdfPart.headerText.match(/filename="([^"]+)"/i);
    const fileName = disposition ? disposition[1] : 'upload.pdf';
    const tempPath = path.join(uploadsDir, `${Date.now()}-${fileName}`);
    fs.writeFileSync(tempPath, pdfPart.contentBuffer);

    const extracted = extractPdfText(tempPath);
    const debugOutput = [];
    const references = extractReferencesFromText(extracted.processed, debugRequested ? debugOutput : null);
    const analyzed = new Array(references.length);

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache'
    });
    writeAnalyzeEvent(res, 'references-found', { total: references.length });

    for (let index = 0; index < references.length; index += 1) {
      writeAnalyzeEvent(res, 'checking-reference', {
        index: index + 1,
        total: references.length
      });
      analyzed[index] = await analyzeReference(references[index]);
      writeAnalyzeEvent(res, 'checked-reference', {
        index: index + 1,
        total: references.length,
        confidence: analyzed[index].confidence,
        doi: analyzed[index].doi
      });
    }

    fs.unlinkSync(tempPath);

    writeAnalyzeEvent(res, 'complete', {
      result: buildAnalyzeResponse({
      filename: fileName,
      extracted,
      references: analyzed,
      engineVersion: ENGINE_VERSION,
      debugRequested,
      debugOutput
      })
    });
    res.end();
  } catch (error) {
    console.error(error);
    if (res.headersSent) {
      writeAnalyzeEvent(res, 'error', { error: error.message });
      res.end();
    } else {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  }
}

function serveStatic(req, res) {
  const reqPath = req.url === '/' ? '/index.html' : req.url;
  const safePath = path.normalize(reqPath).replace(/^\.+/, '');
  const filePath = path.join(__dirname, 'public', safePath);

  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404); res.end('Not found'); return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8'
    }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/analyze') return handleAnalyze(req, res);
  if (req.method === 'GET' && req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, engineVersion: ENGINE_VERSION }));
    return;
  }
  serveStatic(req, res);
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Citecheck running on http://localhost:${PORT}`);
  });
}

module.exports = {
  extractReferencesFromText,
  extractPdfText,
  analyzeReference,
  cleanExtractedText,
  reorderTextForColumns,
  looksLikeExtractedReferences,
  stripPageHeaders,
  buildAnalyzeResponse,
  scoreCandidateMatch,
  rankCandidates,
  normalizeCrossrefWork,
  normalizeDoi,
  mapWithConcurrency,
  describeLookupError,
  waitForCrossrefSlot,
  extractTitleCandidate,
  extractReferenceMetadata,
  extractYear
};
