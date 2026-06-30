# Citecheck

Citecheck is a local web app for reviewing academic references in a PDF paper.

## What it does
- Accepts a PDF upload
- Extracts text from the paper
- Finds the references or bibliography section
- Detects DOIs when present
- Queries Crossref for metadata and provides a confidence-based summary
- Presents each citation with a concise review and recommendations

## Run locally

```bash
cd /home/fredm/citecheck
/usr/bin/node /home/fredm/citecheck/server.js
```

Then open http://localhost:3000 in your browser.

## Notes
- The current version is a strong first pass and uses Crossref for DOI-based checking.
- It is designed for local-first use and can be extended with richer citation matching and more authoritative sources.
- Build rule: increment the most minor version number on each new build (for example, 2.0.1 -> 2.0.2 -> 2.0.3).

## Todo
- It's making errors with the parsing of the references, including even the first one, where it fails to end it with "ACM Transactions on Computing Education (2022)" and instead pulls in a DOI from reference [6]. 
- I feel like I need to see the output from the PDFtotext thing in order to debug.
- I want to put a debug harness in - e.g., Console.log()?
- Also I am pretty sure the 2-col thing was a wild goose chase. I want to look at the PDF to text output.