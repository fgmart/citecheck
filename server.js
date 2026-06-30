const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PORT = process.env.PORT || 3000;
const uploadsDir = path.join(__dirname, 'uploads');
const ENGINE_VERSION = 'citecheck-v2.1.0';
const DEBUG_PARSER = process.env.DEBUG_PARSER === 'true';
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
    return lineBasedReferences.filter(Boolean).slice(0, 40);
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
    return references.filter(Boolean).slice(0, 40);
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
  return references.filter(Boolean).slice(0, 40);
}

function inferReferenceType(reference) {
  const lower = reference.toLowerCase();
  if (lower.includes('doi:') || lower.includes('https://doi.org/')) return 'doi';
  if (lower.includes('arxiv')) return 'arxiv';
  if (lower.includes('journal') || lower.includes('proc') || lower.includes('transactions')) return 'article';
  return 'unknown';
}

function extractDoi(reference) {
  const match = reference.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
  return match ? match[0] : null;
}

function extractTitleCandidate(reference) {
  const withoutNumbers = reference.replace(/^(\[\d+\]|\d+[.)]\s*)/, '');
  return withoutNumbers.split(/\s(?=(?:[A-Z][a-z]+|[A-Z]{2,})\s)/)[0] || withoutNumbers.slice(0, 120);
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Remote request failed with status ${response.status}`);
  return response.json();
}

async function analyzeReference(reference) {
  const doi = extractDoi(reference);
  const type = inferReferenceType(reference);
  let confidence = 'low';
  let summary = 'No DOI detected. Best-effort verification will rely on author/title/journal matching.';
  let recommendations = ['Consider adding a DOI or a stable URL for the cited work.'];
  let evidence = [];
  let doiFound = null;

  if (doi) {
    try {
      const data = await fetchJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
      const message = data.message || {};
      const title = Array.isArray(message.title) ? message.title[0] : message.title;
      const authors = Array.isArray(message.author) ? message.author.map((a) => a.family || a.name).slice(0, 3).join(', ') : '';
      const journal = message['container-title'] ? message['container-title'][0] : '';
      doiFound = doi;

      const titleMatch = title ? normalizeText(title).toLowerCase().includes(normalizeText(reference).toLowerCase().slice(0, 80)) : false;
      const journalMatch = journal ? normalizeText(journal).toLowerCase().includes(normalizeText(reference).toLowerCase().slice(0, 80)) : false;

      confidence = titleMatch || journalMatch ? 'high' : 'medium';
      summary = `DOI resolved and metadata was retrieved for ${doi}.`;
      evidence.push(`Title: ${title || 'not available'}`);
      if (authors) evidence.push(`Authors: ${authors}`);
      if (journal) evidence.push(`Journal: ${journal}`);
      recommendations = ['Confirm that the author list, title, and venue exactly match the source metadata.'];
    } catch (error) {
      confidence = 'medium';
      summary = `DOI ${doi} was detected, but the remote lookup did not return metadata.`;
      recommendations = ['Check the DOI manually and confirm the citation fields against the authoritative record.'];
    }
  } else {
    try {
      const titleQuery = encodeURIComponent(extractTitleCandidate(reference));
      const searchData = await fetchJson(`https://api.crossref.org/works?rows=3&query.title=${titleQuery}`);
      const items = searchData.message && Array.isArray(searchData.message.items) ? searchData.message.items : [];
      if (items.length) {
        const first = items[0];
        const foundTitle = first.title ? first.title[0] : '';
        const foundDoi = first.DOI || null;
        doiFound = foundDoi;
        confidence = 'medium';
        summary = `No DOI was present in the citation, but a best-effort Crossref search found a likely match: ${foundTitle || 'unknown title'}.`;
        recommendations = ['Add an explicit DOI or stable URL if available and verify the reference metadata.'];
        evidence.push(`Candidate DOI: ${foundDoi || 'not available'}`);
      }
    } catch (error) {
      summary = 'No DOI was detected and no strong remote match was found.';
      recommendations = ['Add a DOI or a stable URL and verify title, author, and venue details manually.'];
    }
  }

  return {
    reference,
    type,
    doi: doiFound || doi,
    confidence,
    summary,
    recommendations,
    evidence,
    status: 'checked'
  };
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
  const reordered = reorderTextForColumns(withoutHeaders);
  return {
    raw: output,
    cleaned,
    withoutHeaders,
    processed: reordered
  };
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
    const analyzed = await Promise.all(references.map(analyzeReference));

    fs.unlinkSync(tempPath);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      filename: fileName,
      totalCharacters: extracted.processed.length,
      referencesFound: analyzed.length,
      references: analyzed,
      engineVersion: ENGINE_VERSION,
      debugOutput: debugRequested ? debugOutput.join('\n') : null,
      rawExtractedText: extracted.raw,
      cleanedExtractedText: extracted.cleaned,
      processedExtractedText: extracted.processed
    }));
  } catch (error) {
    console.error(error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
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
  stripPageHeaders
};
