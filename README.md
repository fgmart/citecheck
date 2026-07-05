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

Save the below as ```start-server.sh```

```
#!/usr/bin/env bash
set -euo pipefail

export PORT="${PORT:-3000}"
export CROSSREF_CONCURRENCY="${CROSSREF_CONCURRENCY:-1}"
export CROSSREF_RETRIES="${CROSSREF_RETRIES:-4}"
export CROSSREF_MIN_INTERVAL_MS="${CROSSREF_MIN_INTERVAL_MS:-1500}"

exec /usr/bin/node server.js
```

Then open http://localhost:3000 in your browser.

# Version History

## 2.2.10 2026-07-05
- improved page range extraction

## 2.2.9 2026-07-05
- run analysis immediately upon file upload

## 2.2.8 2026-07-05
- extract and compare volume, issue, and pages

## 2.2.7 2026-07-05
- allow full paper upload

## 2.2.6 2026-07-05
- fixed issue with titles with colons

## 2.2.5 2026-07-05
- display author first names from Crossref

## 2.2.4 2026-07-05
- fixed issue with references starting in right column and the parser was pulling text from left column

## 2.2.3 2026-07-05
- made the data presentation in the "evidence" section more compact

## 2.2.2 2026-07-05
- display results with comparison card

## 2.2.1 2026-07-04
- made displayed DOI clickable.

## v2.2.0 2026-07-04
- Codex made parsing improvements. It is a lot better.
- Still have stuff bleeding over from adjacent column into parsed output. Can exercise when references start on page with text next to them.
- Reduced min wait on Crossref to 500 ms. Seems to still work fine.

## 2026-06-29
- still in GH Copilot, adding debug to the main view. Then I saw how messed up the PDFtotext was scrambling the refs. I asked it to think about a visual blocking solution, and amazingly it solved it.
- so then it was extracting the refs quite well, but not validating them with Crossref.
- it wanted to separate out author/title/journal/year to hand off to Crossref.
- That sounded good, but I ran out of free credits, couldn't get GH to accept my $10, and I switched over to Codex.
- Codex that is way more powerful!
- I asked it how to improve the internet cite-checking and it presented a complex plan with rate limiting and then (if Crossref wasn't finding stuff) moving on to OpenAlex and then DataCite.
- I told it to first do the separate-out fields plan, which it also presented.
- That improved things, but I was still getting 429 errors - overloading the API.
- So it added basic rate limiting, which worked!!
- Then it became super slow, of course, so I told it to add progress info, which it has.
- I had updated the v-num to 2.0 back in Copilot once it got the PDF parsing working.
- We are now at v2.1.5 and it's a good stopping point.
- It seems almost useful now! Adding DOIs to cites that don't match well would be a good practice.
- I'm kind of thinking I'd like to see if other can use it.
- maybe ask it for a launch script.
- then move on to the OpenAlex - I have an API key for that already.
- checking in these files now.

## Todo - 2026-06-28
- It's making errors with the parsing of the references, including even the first one, where it fails to end it with "ACM Transactions on Computing Education (2022)" and instead pulls in a DOI from reference [6]. 
- I feel like I need to see the output from the PDFtotext thing in order to debug.
- I want to put a debug harness in - e.g., Console.log()?
- Also I am pretty sure the 2-col thing was a wild goose chase. I want to look at the PDF to text output.

## Notes
- The current version is a strong first pass and uses Crossref for DOI-based checking.
- It is designed for local-first use and can be extended with richer citation matching and more authoritative sources.
- Build rule: increment the most minor version number on each new build (for example, 2.0.1 -> 2.0.2 -> 2.0.3).