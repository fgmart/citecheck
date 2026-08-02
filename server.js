const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { XMLParser } = require('fast-xml-parser');

const PORT = process.env.PORT || 3000;
const uploadsDir = path.join(__dirname, 'uploads');
const ENGINE_VERSION = 'citecheck-v3.6';
const DEBUG_PARSER = process.env.DEBUG_PARSER === 'true';
const CROSSREF_MAILTO = process.env.CROSSREF_MAILTO || '';
const CROSSREF_CONCURRENCY = Number(process.env.CROSSREF_CONCURRENCY || 1);
const CROSSREF_RETRIES = Number(process.env.CROSSREF_RETRIES || 4);
const CROSSREF_MIN_INTERVAL_MS = Number(process.env.CROSSREF_MIN_INTERVAL_MS || 1500);
const CROSSREF_TIMEOUT_MS = Number(process.env.CROSSREF_TIMEOUT_MS || 10000);
const CITECHECK_MAX_REFERENCES = Number(process.env.CITECHECK_MAX_REFERENCES || 100);
const ARXIV_RETRIES = Number(process.env.ARXIV_RETRIES || 3);
const ARXIV_MIN_INTERVAL_MS = Number(process.env.ARXIV_MIN_INTERVAL_MS || 3000);
const ARXIV_TIMEOUT_MS = Number(process.env.ARXIV_TIMEOUT_MS || 10000);
const ARXIV_CACHE_TTL_MS = Number(process.env.ARXIV_CACHE_TTL_MS || 24 * 60 * 60 * 1000);
const ARXIV_CACHE_MAX_ENTRIES = Number(process.env.ARXIV_CACHE_MAX_ENTRIES || 500);
const REFERENCE_HEADING_RE = /^(?:(?:acknowledgments?|acknowledgements?)\s+)?(?:references|bibliography)$/i;
let nextCrossrefRequestAt = 0;
let nextArxivRequestAt = 0;
let arxivRequestQueue = Promise.resolve();
const arxivCache = new Map();
const arxivXmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true
});
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

function repairDoiWrapping(text) {
  return text
    .replace(/(\b(?:doi:\s*|https?:\/\/doi\.org\/)?10\.)\s+(?=\d{4,9}\/)/gi, '$1')
    .replace(/(\b10\.\d{4,9}\/)[\s]+(?=[-._;()/:A-Z0-9])/gi, '$1')
    .replace(/(\b10\.\d{4,9}\/[-._;()/:A-Z0-9]*[-._;()/:])\s+(?=[-._;()/:A-Z0-9])/gi, '$1');
}

function stripPageHeaders(text) {
  const lines = text.split(/\n/).map((line) => line.trim()).filter(Boolean);
  const referenceHeadingIndex = lines.findIndex((line) => REFERENCE_HEADING_RE.test(line));

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
  const authorDateLines = text
    .split(/\r?\n/)
    .filter((line) => looksLikeAuthorDateReferenceStart(line.trim()));
  return markerLines.length >= 3 || authorDateLines.length >= 3;
}

function looksLikeAuthorDateReferenceStart(line) {
  return /^[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+(?:\s+[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+){0,3},\s+.+\((?:19|20)\d{2}(?:[,;)])/.test(line);
}

function extractReferencesFromText(text, debugSink = null) {
  const lines = text.split(/\r?\n/);
  const referenceHeadingIndex = lines.findIndex((line) => REFERENCE_HEADING_RE.test(line.trim()));
  const sectionLines = referenceHeadingIndex >= 0 ? lines.slice(referenceHeadingIndex + 1) : lines;
  const sectionText = repairDoiWrapping(sectionLines.join('\n').trim());

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

  const authorDateReferences = [];
  let currentAuthorDateReference = '';

  for (const rawLine of sectionLinesForDebug) {
    const line = rawLine.trim();
    if (!line) continue;

    if (looksLikeAuthorDateReferenceStart(line)) {
      if (currentAuthorDateReference) authorDateReferences.push(currentAuthorDateReference.trim());
      currentAuthorDateReference = line;
    } else if (currentAuthorDateReference) {
      currentAuthorDateReference += ` ${line}`;
    }
  }

  if (currentAuthorDateReference) authorDateReferences.push(currentAuthorDateReference.trim());

  emitDebug('author-date references', authorDateReferences);

  if (authorDateReferences.length > 1) {
    emitDebug('using author-date extraction');
    return authorDateReferences.filter(Boolean).slice(0, CITECHECK_MAX_REFERENCES);
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
  if (lower.includes('arxiv')) return 'arxiv';
  if (lower.includes('doi:') || lower.includes('https://doi.org/')) return 'doi';
  if (lower.includes('journal') || lower.includes('proc') || lower.includes('transactions')) return 'article';
  return 'unknown';
}

function normalizeDoi(doi) {
  return doi ? doi.replace(/[.,;:]+$/g, '').toLowerCase() : null;
}

function extractArxivIdentifier(reference) {
  const repairedReference = repairDoiWrapping(reference);
  const modernMatch = repairedReference.match(/\barxiv:\s*(\d{4}\.\d{4,5})(v\d+)?\b/i)
    || repairedReference.match(/\barxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})(v\d+)?\b/i)
    || repairedReference.match(/\b10\.48550\/arxiv\.(\d{4}\.\d{4,5})(v\d+)?\b/i);
  const legacyMatch = repairedReference.match(/\barxiv:\s*([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?\b/i)
    || repairedReference.match(/\barxiv\.org\/(?:abs|pdf)\/([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?\b/i)
    || repairedReference.match(/\b10\.48550\/arxiv\.([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?\b/i);
  const match = modernMatch || legacyMatch;
  if (!match) return null;

  const baseId = match[1];
  const version = match[2] || '';
  return {
    baseId,
    version,
    requestedId: `${baseId}${version}`,
    canonicalDoi: normalizeDoi(`10.48550/arXiv.${baseId}`)
  };
}

function extractDoi(reference) {
  const repairedReference = repairDoiWrapping(reference);
  const match = repairedReference.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
  if (match) return normalizeDoi(match[0]);

  const arxivIdentifier = extractArxivIdentifier(repairedReference);
  return arxivIdentifier ? arxivIdentifier.canonicalDoi : null;
}

function stripReferenceMarker(reference) {
  return reference.replace(/^(\[\d+\]|\d+[.)])\s*/, '').trim();
}

function findQuotedTitle(reference) {
  const withoutMarker = stripReferenceMarker(reference);
  const match = withoutMarker.match(/[“"]([^”"]{3,})[”"]/);
  if (!match) return null;
  const beforeQuote = withoutMarker.slice(0, match.index);
  if (/\b(?:19|20)\d{2}\b/.test(beforeQuote)) return null;
  return {
    title: normalizeText(match[1]).replace(/[,;:\s]+$/g, ''),
    start: match.index,
    end: match.index + match[0].length,
    source: withoutMarker
  };
}

function extractTitleCandidate(reference) {
  const quotedTitle = findQuotedTitle(reference);
  if (quotedTitle) return quotedTitle.title;

  const withoutNumbers = stripReferenceMarker(reference);
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
    const hasVenueIndicator = /\b(?:journal|proceedings?|transactions?|conference|press|springer|ieee|acm|arxiv|doi|https?)\b|(?:^|\s)proc\.(?=\s|$)/i.test(segment);
    return words.length >= 2 && !/[;]/.test(segment) && !hasVenueIndicator;
  });

  return titleCandidate || titleSource.replace(/^[.\s]+/, '').slice(0, 160);
}

function shouldSearchArxiv(reference) {
  if (extractArxivIdentifier(reference)) return true;
  if (/\[\s*n\s*\.\s*d\s*\.\s*\]/i.test(reference)) return false;
  if (/\bretrieved\b[\s\S]*\bfrom\s+https?:\/\//i.test(reference)) return false;

  const metadata = extractReferenceMetadata(reference);
  if (metadata.venue || metadata.pages || metadata.volume || metadata.issue) return false;

  const title = extractTitleCandidate(reference);
  return Boolean(extractYear(reference) && title && title.split(/\s+/).filter(Boolean).length >= 4);
}

function extractYear(reference) {
  const match = reference.match(/\b(19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

function cleanReferenceForMetadata(reference) {
  return reference
    .replace(/^(\[\d+\]|\d+[.)])\s*/, '')
    .replace(/\barXiv:\S+/gi, '')
    .replace(/\bdoi:\s*10\.\d{4,9}\/[-._;()/:A-Z0-9]+/gi, '')
    .replace(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+/gi, '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractAuthorsCandidate(reference) {
  const cleaned = cleanReferenceForMetadata(reference);
  const quotedTitle = findQuotedTitle(cleaned);
  if (quotedTitle) {
    return quotedTitle.source
      .slice(0, quotedTitle.start)
      .replace(/[,;:\s]+$/g, '')
      .slice(0, 240);
  }

  const year = extractYear(cleaned);
  const beforeYear = year ? cleaned.slice(0, cleaned.indexOf(String(year))).trim() : cleaned.split(/\.\s+/)[0] || '';
  let authors = beforeYear
    .replace(/[\s([{]+$/g, '')
    .replace(/[,;:\s]+$/g, '');
  if (!/(?:^|[\s,])[A-Z]\.$/.test(authors)) {
    authors = authors.replace(/\.+$/g, '');
  }
  return authors.slice(0, 240);
}

function extractVenueCandidate(reference) {
  return extractPublicationDetails(reference).venue;
}

function normalizePageRange(value) {
  return normalizeText(value || '')
    .replace(/\s*[–—-]\s*/g, '-')
    .replace(/[.,;:\s]+$/g, '')
    .toLowerCase();
}

function normalizeMetadataValue(value) {
  return normalizeText(value || '').replace(/[.,;:\s]+$/g, '').toLowerCase();
}

function metadataMatched(left, right, normalizer = normalizeMetadataValue) {
  return Boolean(left && right && normalizer(left) === normalizer(right));
}

function extractTrailingPageRange(text) {
  const matches = Array.from(normalizeText(text).matchAll(/\b(\d+\s*[–—-]\s*\d+)\b/g));
  if (!matches.length) return '';
  return matches[matches.length - 1][1].trim();
}

function extractIeeePublicationDetails(reference) {
  const cleaned = cleanReferenceForMetadata(reference);
  const quotedTitle = findQuotedTitle(cleaned);
  if (!quotedTitle) return null;

  let details = quotedTitle.source
    .slice(quotedTitle.end)
    .replace(/^[,\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!details) {
    return { venue: '', volume: '', issue: '', pages: '' };
  }

  details = details.replace(/[.;\s]+$/g, '');
  const volumeMatch = details.match(/\bvol\.\s*([A-Za-z0-9-]+)/i);
  const issueMatch = details.match(/\bno\.\s*([A-Za-z0-9-]+)/i);
  const pagesMatch = details.match(/\bpp?\.\s*([^,.;]+)/i);
  const trailingYearMatch = details.match(/(?:^|,\s*)((?:19|20)\d{2})[.;\s]*$/);

  let venue = details
    .replace(/\bvol\.\s*[A-Za-z0-9-]+.*$/i, '')
    .replace(/\bpp?\.\s*[^,.;]+.*$/i, '')
    .replace(trailingYearMatch ? new RegExp(`,?\\s*${trailingYearMatch[1]}[.;\\s]*$`) : /$/, '')
    .replace(/^[,\s]+/, '')
    .replace(/[,;\s]+$/g, '')
    .replace(/^\s*in\s+/i, '')
    .trim();

  // IEEE conference citations commonly put a parenthesized acronym after the
  // venue and the conference location after that. Keep the acronym, but do not
  // report the city/country fields as part of the publication venue.
  const conferenceVenue = venue.match(/^(.+\([^)]*\))(?:,\s*.+)$/);
  if (conferenceVenue) venue = conferenceVenue[1].trim();

  return {
    venue,
    volume: volumeMatch ? volumeMatch[1].trim() : '',
    issue: issueMatch ? issueMatch[1].trim() : '',
    pages: pagesMatch ? pagesMatch[1].trim() : extractTrailingPageRange(details)
  };
}

function extractPublicationDetails(reference) {
  const ieeeDetails = extractIeeePublicationDetails(reference);
  if (ieeeDetails) return ieeeDetails;

  const cleaned = cleanReferenceForMetadata(reference);
  const title = extractTitleCandidate(reference);
  let afterTitle = cleaned;
  const titleIndex = title ? cleaned.toLowerCase().indexOf(title.toLowerCase()) : -1;
  if (titleIndex >= 0) afterTitle = cleaned.slice(titleIndex + title.length);
  afterTitle = afterTitle.replace(/^[.,\s]+/, '').trim();

  const proceedingsWithAcronym = afterTitle.match(/^In\s+(Proceedings.+\([^)]*\))(?=,|\.)/i);
  if (proceedingsWithAcronym) {
    return {
      venue: proceedingsWithAcronym[1].trim(),
      volume: '',
      issue: '',
      pages: extractTrailingPageRange(afterTitle)
    };
  }

  const dateParenthetical = "\\([^)]*(?:19|20)\\d{2}[^)]*\\)";
  const missingVenueWithIssue = afterTitle.match(new RegExp(`^(\\d+[A-Za-z]?),\\s*([A-Za-z0-9-]+)\\s*${dateParenthetical},\\s*([^.;]+(?:[–—-][^.;]+)?)`));
  if (missingVenueWithIssue) {
    return {
      venue: '',
      volume: missingVenueWithIssue[1].trim(),
      issue: missingVenueWithIssue[2].trim(),
      pages: missingVenueWithIssue[3].trim()
    };
  }

  const journalWithIssue = afterTitle.match(new RegExp(`^(.+?)\\s+(\\d+[A-Za-z]?),\\s*([A-Za-z0-9-]+)\\s*${dateParenthetical},\\s*([^.;]+(?:[–—-][^.;]+)?)`));
  if (journalWithIssue) {
    return {
      venue: journalWithIssue[1].replace(/^\s*In\s+/i, '').trim(),
      volume: journalWithIssue[2].trim(),
      issue: journalWithIssue[3].trim(),
      pages: journalWithIssue[4].trim()
    };
  }

  const journalWithoutIssue = afterTitle.match(new RegExp(`^(.+?)\\s+(\\d+[A-Za-z]?)\\s*${dateParenthetical},\\s*([^.;]+(?:[–—-][^.;]+)?)`));
  if (journalWithoutIssue) {
    return {
      venue: journalWithoutIssue[1].replace(/^\s*In\s+/i, '').trim(),
      volume: journalWithoutIssue[2].trim(),
      issue: '',
      pages: journalWithoutIssue[3].trim()
    };
  }

  const articleDetails = afterTitle.match(/^(.+?)\s+(\d+[A-Za-z]?),\s*([A-Za-z0-9-]+),\s*(Article\s+[^,(]+).*?,\s*([^.;]*pages?)/i);
  if (articleDetails) {
    return {
      venue: articleDetails[1].replace(/^\s*In\s+/i, '').trim(),
      volume: articleDetails[2].trim(),
      issue: articleDetails[3].trim(),
      pages: `${articleDetails[4].trim()}, ${articleDetails[5].trim()}`
    };
  }

  const venueWithTrailingPages = afterTitle.match(/^([^.]+?),\s*(\d+\s*[–—-]\s*\d+)[.;\s]*$/);
  if (venueWithTrailingPages) {
    return {
      venue: venueWithTrailingPages[1].replace(/^\s*In\s+/i, '').trim(),
      volume: '',
      issue: '',
      pages: venueWithTrailingPages[2].trim()
    };
  }

  const venuePatterns = [
    /\b(?:In\s+)?(Proceedings[^.]+)\./i,
    /\bIn\s+([^.]+)\./i,
    /\b((?:ACM|IEEE|Journal|Computers?|Education|Educational|Interactive|Technology|Research|Review|Communications|Transactions|Conference|Proc\.)[^.]+)\./i
  ];

  for (const pattern of venuePatterns) {
    const match = afterTitle.match(pattern);
    if (match && match[1]) {
      return {
        venue: match[1].replace(/^\s*In\s+/i, '').trim(),
        volume: '',
        issue: '',
        pages: extractTrailingPageRange(afterTitle)
      };
    }
  }

  const segments = afterTitle
    .split(/\.\s*/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const venue = segments.find((segment) => /(journal|proc|proceedings|conference|transactions|education|review|communications|press|springer|ieee|acm|sage|wiley)/i.test(segment));
  return {
    venue: venue ? venue.slice(0, 240) : '',
    volume: '',
    issue: '',
    pages: extractTrailingPageRange(afterTitle)
  };
}

function extractReferenceMetadata(reference) {
  const publication = extractPublicationDetails(reference);
  return {
    authors: extractAuthorsCandidate(reference),
    date: extractYear(reference) ? String(extractYear(reference)) : '',
    title: extractTitleCandidate(reference),
    venue: publication.venue,
    volume: publication.volume,
    issue: publication.issue,
    pages: publication.pages
  };
}

function candidateMetadata(candidate = {}) {
  return {
    authors: candidate.authors || '',
    date: candidate.year ? String(candidate.year) : '',
    title: candidate.title || '',
    venue: candidate.containerTitle || candidate.publisher || '',
    volume: candidate.volume || '',
    issue: candidate.issue || '',
    pages: candidate.pages || ''
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
  return (2 * overlap.length) / Math.max(1, left.length + right.length);
}

function formatScoreLabel(score) {
  if (score >= 0.8) return 'strong';
  if (score >= 0.45) return 'medium';
  if (score > 0) return 'weak';
  return 'none';
}

function scoreCandidateMatch(reference, candidate = {}) {
  const extractedMetadata = extractReferenceMetadata(reference);
  const hasAbbreviatedAuthorList = /\bet\s+al\b/i.test(extractedMetadata.authors);
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
  const volumeMatched = metadataMatched(extractedMetadata.volume, candidate.volume);
  const issueMatched = metadataMatched(extractedMetadata.issue, candidate.issue);
  const pagesMatched = metadataMatched(extractedMetadata.pages, candidate.pages, normalizePageRange);
  const publicationDetailBonus = [volumeMatched, issueMatched, pagesMatched].filter(Boolean).length * 0.03;
  const yearPenalty = severeYearMismatch ? 0.35 : yearMismatched ? 0.15 : 0;
  const weakTitlePenalty = titleScore < 0.25 ? 0.15 : 0;
  const score = Math.max(0, Math.min(1, titleScore * 0.5 + authorScore * 0.2 + yearScore * 0.15 + venueScore * 0.1 + doiBonus + publicationDetailBonus - yearPenalty - weakTitlePenalty));

  let confidence = 'low';
  if (score >= 0.75 && titleScore >= 0.45) confidence = 'high';
  else if (score >= 0.4 && titleScore >= 0.25) confidence = 'medium';
  if (severeYearMismatch && !doiMatched) confidence = 'low';

  const hasMatchedPublicationDetails = volumeMatched || issueMatched || pagesMatched;
  const hasSupportingIdentityMatch = doiMatched || authorScore > 0 || hasMatchedPublicationDetails;
  if (confidence === 'high' && !hasSupportingIdentityMatch) confidence = 'medium';
  if (confidence === 'high' && hasAbbreviatedAuthorList) confidence = 'medium';
  if (confidence === 'medium' && !hasSupportingIdentityMatch && titleScore < 0.75) confidence = 'low';

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

  if (extractedMetadata.volume || candidate.volume) {
    evidence.push(volumeMatched ? `Volume matched: ${candidate.volume}` : `Volume mismatch: cited ${extractedMetadata.volume || 'unavailable'}, candidate ${candidate.volume || 'unavailable'}`);
  }
  if (extractedMetadata.issue || candidate.issue) {
    evidence.push(issueMatched ? `Issue matched: ${candidate.issue}` : `Issue mismatch: cited ${extractedMetadata.issue || 'unavailable'}, candidate ${candidate.issue || 'unavailable'}`);
  }
  if (extractedMetadata.pages || candidate.pages) {
    evidence.push(pagesMatched ? `Pages matched: ${candidate.pages}` : `Pages mismatch: cited ${extractedMetadata.pages || 'unavailable'}, candidate ${candidate.pages || 'unavailable'}`);
  }

  if (doiMatched) evidence.push('DOI exactly matched');
  if (hasAbbreviatedAuthorList) evidence.push('Cited author list uses et al.; confidence capped at medium');

  return {
    score,
    confidence,
    evidence,
    details: {
      titleScore,
      authorScore,
      venueScore,
      volumeMatched,
      issueMatched,
      pagesMatched,
      yearMatched,
      yearMismatched,
      severeYearMismatch,
      doiMatched,
      hasAbbreviatedAuthorList
    }
  };
}

function getCrossrefYear(work = {}) {
  const dateSource = work['published-print']
    || (work['journal-issue'] && work['journal-issue']['published-print'])
    || work.issued
    || work.published
    || work['published-online']
    || work.created;
  const dateParts = dateSource && dateSource['date-parts'];
  return Array.isArray(dateParts) && Array.isArray(dateParts[0]) ? dateParts[0][0] : null;
}

function formatCrossrefAuthor(author = {}) {
  if (author.name) return author.name;
  return [author.given, author.family].filter(Boolean).join(' ') || author.family || '';
}

function normalizeCrossrefWork(work = {}) {
  const authors = Array.isArray(work.author)
    ? work.author.map(formatCrossrefAuthor).filter(Boolean).join(', ')
    : '';
  const title = Array.isArray(work.title) ? work.title[0] : work.title || '';
  const subtitle = Array.isArray(work.subtitle) ? work.subtitle[0] : work.subtitle || '';
  const fullTitle = title && subtitle && !title.toLowerCase().includes(subtitle.toLowerCase())
    ? `${title.replace(/[:\s]+$/g, '')}: ${subtitle}`
    : title || subtitle;

  return {
    source: 'crossref',
    doi: normalizeDoi(work.DOI || work.doi || ''),
    title: fullTitle,
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

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function xmlText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' || typeof value === 'number') return normalizeText(String(value));
  return normalizeText(String(value['#text'] || ''));
}

function parseArxivEntryId(value) {
  const rawId = xmlText(value).replace(/^https?:\/\/arxiv\.org\/abs\//i, '');
  const match = rawId.match(/^(.+?)(v\d+)?$/i);
  return {
    baseId: match ? match[1] : rawId,
    version: match && match[2] ? match[2] : ''
  };
}

function normalizeArxivEntry(entry = {}) {
  const identifier = parseArxivEntryId(entry.id);
  if (!identifier.baseId) return null;

  const authors = asArray(entry.author)
    .map((author) => xmlText(author && author.name))
    .filter(Boolean)
    .join(', ');
  const categories = asArray(entry.category)
    .map((category) => category && category['@_term'])
    .filter(Boolean);
  const primaryCategory = entry['arxiv:primary_category'] && entry['arxiv:primary_category']['@_term']
    ? entry['arxiv:primary_category']['@_term']
    : categories[0] || '';
  const links = asArray(entry.link);
  const abstractLink = links.find((link) => link && link['@_rel'] === 'alternate');
  const published = xmlText(entry.published);
  const publicationDoi = normalizeDoi(xmlText(entry['arxiv:doi']));

  return {
    source: 'arxiv',
    doi: normalizeDoi(`10.48550/arXiv.${identifier.baseId}`),
    title: xmlText(entry.title),
    authors,
    containerTitle: 'arXiv',
    year: /^\d{4}/.test(published) ? Number(published.slice(0, 4)) : null,
    volume: '',
    issue: '',
    pages: '',
    publisher: '',
    url: abstractLink && abstractLink['@_href'] ? abstractLink['@_href'] : `https://arxiv.org/abs/${identifier.baseId}${identifier.version}`,
    arxivId: identifier.baseId,
    arxivVersion: identifier.version,
    primaryCategory,
    categories,
    published,
    updated: xmlText(entry.updated),
    journalReference: xmlText(entry['arxiv:journal_ref']),
    publicationDoi
  };
}

function parseArxivFeed(xml) {
  const parsed = arxivXmlParser.parse(xml);
  const entries = parsed && parsed.feed ? asArray(parsed.feed.entry) : [];
  return entries.map(normalizeArxivEntry).filter(Boolean);
}

function buildArxivUrl(params = {}) {
  const url = new URL('https://export.arxiv.org/api/query');
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  });
  return url.toString();
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

function isRetriableArxivStatus(status) {
  return status !== 429 && isRetriableStatus(status);
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

function fetchWithTimeout(url, fetchOptions = {}, timeoutMs, source, fetchImpl = global.fetch) {
  const controller = new AbortController();
  const timeoutError = new Error(`${source} request timed out after ${timeoutMs} ms`);
  timeoutError.code = 'ETIMEDOUT';
  let timeoutId;
  const timeoutPromise = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });
  const requestPromise = Promise.resolve().then(() => fetchImpl(url, {
    ...fetchOptions,
    signal: controller.signal
  }));

  return Promise.race([requestPromise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

async function fetchJson(url, options = {}) {
  const retries = options.retries ?? CROSSREF_RETRIES;
  const timeoutMs = options.timeoutMs ?? CROSSREF_TIMEOUT_MS;
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let response = null;

    try {
      await waitForCrossrefSlot();
      response = await fetchWithTimeout(url, {
        headers: {
          'User-Agent': `${ENGINE_VERSION}${CROSSREF_MAILTO ? ` (mailto:${CROSSREF_MAILTO})` : ''}`
        }
      }, timeoutMs, 'Crossref');

      if (response.ok) return response.json();

      lastError = new Error(`Remote request failed with status ${response.status}`);
      lastError.status = response.status;
      if (!isRetriableStatus(response.status) || attempt === retries) break;
    } catch (error) {
      lastError = error;
      if (error.code === 'ETIMEDOUT' || attempt === retries) break;
    }

    await sleep(getRetryDelay(attempt, response));
  }

  throw lastError || new Error('Remote request failed');
}

async function waitForArxivSlot(now = Date.now()) {
  const scheduledAt = Math.max(now, nextArxivRequestAt);
  nextArxivRequestAt = scheduledAt + ARXIV_MIN_INTERVAL_MS;
  const delay = scheduledAt - now;
  if (delay > 0) await sleep(delay);
}

function scheduleArxivRequest(task) {
  const scheduled = arxivRequestQueue.then(task, task);
  arxivRequestQueue = scheduled.catch(() => {});
  return scheduled;
}

async function fetchArxivText(url, options = {}) {
  const retries = options.retries ?? ARXIV_RETRIES;
  const timeoutMs = options.timeoutMs ?? ARXIV_TIMEOUT_MS;
  return scheduleArxivRequest(async () => {
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      let response = null;
      try {
        await waitForArxivSlot();
        response = await fetchWithTimeout(url, {
          headers: {
            'User-Agent': `${ENGINE_VERSION}${CROSSREF_MAILTO ? ` (mailto:${CROSSREF_MAILTO})` : ''}`
          }
        }, timeoutMs, 'arXiv');
        if (response.ok) return response.text();

        lastError = new Error(`arXiv request failed with status ${response.status}`);
        lastError.status = response.status;
        if (!isRetriableArxivStatus(response.status) || attempt === retries) break;
      } catch (error) {
        lastError = error;
        if (error.code === 'ETIMEDOUT' || attempt === retries) break;
      }

      await sleep(getRetryDelay(attempt, response));
    }

    throw lastError || new Error('arXiv request failed');
  });
}

function getArxivCache(key, now = Date.now()) {
  const cached = arxivCache.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt <= now) {
    arxivCache.delete(key);
    return undefined;
  }
  return cached.value;
}

function setArxivCache(key, value, now = Date.now()) {
  if (arxivCache.has(key)) arxivCache.delete(key);
  arxivCache.set(key, { value, expiresAt: now + ARXIV_CACHE_TTL_MS });
  while (arxivCache.size > ARXIV_CACHE_MAX_ENTRIES) {
    arxivCache.delete(arxivCache.keys().next().value);
  }
}

async function fetchArxivEntriesByIds(identifiers = []) {
  const requested = Array.from(new Set(identifiers.map((identifier) => {
    if (typeof identifier === 'string') return identifier;
    return identifier && identifier.requestedId;
  }).filter(Boolean)));
  const results = new Map();
  const uncached = [];

  for (const requestedId of requested) {
    const cacheKey = `id:${requestedId.toLowerCase()}`;
    const cached = getArxivCache(cacheKey);
    if (cached !== undefined) {
      results.set(requestedId.toLowerCase(), cached);
    } else {
      uncached.push(requestedId);
    }
  }

  if (uncached.length) {
    const xml = await fetchArxivText(buildArxivUrl({
      id_list: uncached.join(','),
      max_results: uncached.length
    }));
    const entries = parseArxivFeed(xml);

    for (const requestedId of uncached) {
      const requestedBase = requestedId.replace(/v\d+$/i, '').toLowerCase();
      const candidate = entries.find((entry) => entry.arxivId.toLowerCase() === requestedBase) || null;
      const cacheKey = `id:${requestedId.toLowerCase()}`;
      setArxivCache(cacheKey, candidate);
      results.set(requestedId.toLowerCase(), candidate);
    }
  }

  return results;
}

async function searchArxivCandidates(reference, maxResults = 5) {
  const title = extractTitleCandidate(reference);
  if (!title) return [];
  const normalizedTitle = normalizeText(title).replace(/["“”]/g, ' ');
  const cacheKey = `title:${normalizedTitle.toLowerCase()}:${maxResults}`;
  const cached = getArxivCache(cacheKey);
  if (cached !== undefined) return cached;

  const xml = await fetchArxivText(buildArxivUrl({
    search_query: `ti:"${normalizedTitle}"`,
    start: 0,
    max_results: maxResults,
    sortBy: 'relevance',
    sortOrder: 'descending'
  }));
  const candidates = parseArxivFeed(xml);
  setArxivCache(cacheKey, candidates);
  return candidates;
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

function isViableSearchCandidate(candidate) {
  return Boolean(candidate && candidate.match && candidate.match.score >= 0.15);
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

function confidenceForLookupError(error) {
  return error && error.status === 404 ? 'low' : 'medium';
}

async function analyzeReference(reference, options = {}) {
  const doi = extractDoi(reference);
  const type = inferReferenceType(reference);
  const arxivIdentifier = extractArxivIdentifier(reference);
  const extractedMetadata = extractReferenceMetadata(reference);
  let confidence = 'low';
  let summary = 'No DOI detected. Best-effort verification will rely on author/title/journal matching.';
  let recommendations = ['Consider adding a DOI or a stable URL for the cited work.'];
  let evidence = [];
  let doiFound = null;
  let matchedMetadata = candidateMetadata();
  let matchedSource = null;

  if (arxivIdentifier) {
    try {
      if (options.arxivLookupError) throw options.arxivLookupError;
      let candidate;
      if (options.arxivCandidates instanceof Map) {
        candidate = options.arxivCandidates.get(arxivIdentifier.requestedId.toLowerCase()) || null;
      } else {
        const lookup = options.fetchArxivEntriesByIds || fetchArxivEntriesByIds;
        const candidates = await lookup([arxivIdentifier]);
        candidate = candidates.get(arxivIdentifier.requestedId.toLowerCase()) || null;
      }

      doiFound = arxivIdentifier.canonicalDoi;
      matchedSource = 'arxiv';
      if (!candidate) {
        confidence = 'low';
        summary = `arXiv identifier ${arxivIdentifier.requestedId} was not found in the arXiv API.`;
        evidence = [`arXiv identifier not found: ${arxivIdentifier.requestedId}`];
        recommendations = ['Check the arXiv identifier and confirm that the cited preprint is publicly available.'];
      } else {
        const match = scoreCandidateMatch(reference, candidate);
        confidence = match.confidence;
        const versionMismatched = Boolean(arxivIdentifier.version && candidate.arxivVersion !== arxivIdentifier.version);
        if (versionMismatched && confidence === 'high') confidence = 'medium';
        matchedMetadata = candidateMetadata(candidate);
        summary = `arXiv identifier ${arxivIdentifier.requestedId} resolved to ${describeCandidate(candidate)}.`;
        evidence = [
          `arXiv identifier matched: ${candidate.arxivId}${candidate.arxivVersion}`,
          `arXiv title: ${candidate.title || 'not available'}`,
          ...match.evidence
        ];
        if (candidate.authors) evidence.push(`arXiv authors: ${candidate.authors}`);
        if (candidate.primaryCategory) evidence.push(`arXiv primary category: ${candidate.primaryCategory}`);
        if (arxivIdentifier.version) {
          evidence.push(versionMismatched
            ? `arXiv version mismatch: cited ${arxivIdentifier.version}, returned ${candidate.arxivVersion || 'unversioned'}`
            : `arXiv version matched: ${arxivIdentifier.version}`);
        }
        if (candidate.journalReference) evidence.push(`arXiv journal reference: ${candidate.journalReference}`);
        if (candidate.publicationDoi) evidence.push(`arXiv publication DOI: ${candidate.publicationDoi}`);
        recommendations = confidence === 'low'
          ? ['The arXiv identifier resolved, but the cited metadata differs substantially from the arXiv record. Review it manually.']
          : ['Confirm that the cited arXiv version is the intended version.'];
      }
    } catch (error) {
      confidence = confidenceForLookupError(error);
      doiFound = arxivIdentifier.canonicalDoi;
      matchedSource = 'arxiv';
      summary = `arXiv identifier ${arxivIdentifier.requestedId} was detected, but the arXiv lookup failed: ${describeLookupError(error)}.`;
      evidence = [`arXiv lookup error: ${describeLookupError(error)}`];
      recommendations = ['Check the arXiv identifier manually and retry when the arXiv API is available.'];
    }
  } else if (doi) {
    try {
      const lookup = options.fetchCrossrefWorkByDoi || fetchCrossrefWorkByDoi;
      const candidate = await lookup(doi);
      const match = scoreCandidateMatch(reference, candidate);
      confidence = match.confidence;
      doiFound = candidate.doi || doi;
      matchedMetadata = candidateMetadata(candidate);
      matchedSource = 'crossref';
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
      confidence = confidenceForLookupError(error);
      matchedSource = 'crossref';
      summary = `DOI ${doi} was detected, but the Crossref lookup failed: ${describeLookupError(error)}.`;
      evidence = [`Lookup error: ${describeLookupError(error)}`];
      recommendations = ['Check the DOI manually and confirm the citation fields against the authoritative record.'];
    }
  } else {
    try {
      const crossrefSearch = options.searchCrossrefCandidates || searchCrossrefCandidates;
      const ranked = rankCandidates(reference, await crossrefSearch(reference));
      const viable = ranked.filter(isViableSearchCandidate);
      const best = viable[0];
      const second = viable[1];
      let usedArxivFallback = false;

      const arxivEligible = shouldSearchArxiv(reference);
      if ((!best || best.match.confidence === 'low') && arxivEligible) {
        try {
          const arxivSearch = options.searchArxivCandidates || searchArxivCandidates;
          const arxivRanked = rankCandidates(reference, await arxivSearch(reference));
          const bestArxiv = arxivRanked[0];
          if (bestArxiv && bestArxiv.match.confidence !== 'low') {
            confidence = bestArxiv.match.confidence === 'high' ? 'medium' : bestArxiv.match.confidence;
            doiFound = bestArxiv.doi;
            matchedMetadata = candidateMetadata(bestArxiv);
            matchedSource = 'arxiv';
            usedArxivFallback = true;
            summary = `Crossref had no viable match. Best arXiv candidate: ${describeCandidate(bestArxiv)}.`;
            recommendations = ['Add the arXiv identifier or a stable URL if this is the intended preprint.'];
            evidence = [
              `arXiv candidates reviewed: ${arxivRanked.length}`,
              `Best arXiv score: ${bestArxiv.match.score.toFixed(2)}`,
              ...bestArxiv.match.evidence
            ];
            if (bestArxiv.authors) evidence.push(`arXiv candidate authors: ${bestArxiv.authors}`);
            if (bestArxiv.primaryCategory) evidence.push(`arXiv primary category: ${bestArxiv.primaryCategory}`);
            evidence.push('Identifier-free arXiv search matches are capped at medium confidence');
          }
        } catch (arxivError) {
          if (!best) {
            evidence.push('Crossref returned no candidates');
            evidence.push(`arXiv fallback error: ${describeLookupError(arxivError)}`);
          }
        }
      }

      if (best && !usedArxivFallback) {
        confidence = best.match.confidence;
        if (confidence === 'high') confidence = 'medium';
        doiFound = best.doi;
        matchedMetadata = candidateMetadata(best);
        matchedSource = 'crossref';
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
      } else if (!best && !usedArxivFallback) {
        confidence = 'low';
        summary = arxivEligible
          ? 'No viable record was found in Crossref or arXiv.'
          : 'No viable record was found in Crossref; arXiv fallback was not applicable to this citation.';
        recommendations = ['Add a DOI, arXiv identifier, or stable URL and verify the citation manually.'];
        if (!evidence.length) evidence = arxivEligible
          ? ['Crossref returned no candidates', 'arXiv returned no viable candidates']
          : ['Crossref returned no candidates', 'arXiv fallback was not applicable to this citation'];
      }
    } catch (error) {
      matchedSource = 'crossref';
      summary = `No DOI was detected and Crossref candidate search failed: ${describeLookupError(error)}.`;
      evidence = [`Lookup error: ${describeLookupError(error)}`];
      recommendations = ['Add a DOI or a stable URL and verify title, author, and venue details manually.'];
    }
  }

  return {
    reference,
    type,
    doi: doiFound || doi,
    source: matchedSource,
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
  let tempPath = null;

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
    tempPath = path.join(uploadsDir, `${Date.now()}-${fileName}`);
    fs.writeFileSync(tempPath, pdfPart.contentBuffer);

    const extracted = extractPdfText(tempPath);
    const debugOutput = [];
    const references = extractReferencesFromText(extracted.processed, debugRequested ? debugOutput : null);
    const analyzed = new Array(references.length);
    const arxivIdentifiers = references.map(extractArxivIdentifier).filter(Boolean);
    let arxivCandidates = new Map();
    let arxivLookupError = null;
    let arxivBatchAttempted = false;

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
      if (!arxivBatchAttempted && arxivIdentifiers.length && extractArxivIdentifier(references[index])) {
        arxivBatchAttempted = true;
        try {
          arxivCandidates = await fetchArxivEntriesByIds(arxivIdentifiers);
        } catch (error) {
          arxivLookupError = error;
        }
      }
      analyzed[index] = await analyzeReference(references[index], {
        arxivCandidates,
        arxivLookupError
      });
      writeAnalyzeEvent(res, 'checked-reference', {
        index: index + 1,
        total: references.length,
        confidence: analyzed[index].confidence,
        doi: analyzed[index].doi
      });
    }

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
  } finally {
    if (tempPath) {
      try {
        fs.unlinkSync(tempPath);
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') {
          console.error(`Failed to delete temporary upload ${tempPath}:`, cleanupError);
        }
      }
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
  normalizeArxivEntry,
  parseArxivFeed,
  normalizeDoi,
  mapWithConcurrency,
  describeLookupError,
  confidenceForLookupError,
  waitForCrossrefSlot,
  extractTitleCandidate,
  extractReferenceMetadata,
  extractYear,
  extractDoi,
  extractArxivIdentifier,
  shouldSearchArxiv,
  fetchWithTimeout,
  isRetriableArxivStatus,
  isViableSearchCandidate,
  fetchArxivEntriesByIds,
  searchArxivCandidates,
  repairDoiWrapping
};
