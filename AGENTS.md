# Citecheck Repository Instructions

## Local development

- Start the local server with `bash start-server.local.sh`.
- Do not use `start-server.sh` directly for local development; the local wrapper supplies the required environment configuration.
- The application is available at `http://localhost:3000` after startup.
- Verify a running server with `curl -s http://localhost:3000/api/health`.

## Tests

- Run `node --test test-header.js` after changing citation extraction, parsing, matching, or metadata behavior.
- Run `git diff --check` before considering a change complete.
- Add regression coverage to `test-header.js` for parser bugs and newly supported citation formats.

## Test data

- Use synthetic names, titles, venues, locations, identifiers, and citation data in `test-header.js`.
- Do not copy real authors, paper titles, publication venues, DOIs, or other identifying citation details into regression fixtures.
- Preserve the citation structure and parsing edge case being tested when converting a real-world failure into synthetic test data.

## Versioning

- Increment the patch component of `ENGINE_VERSION` in `server.js` for each new build.
- Add the corresponding version entry to the version history in `README.md` with a concise description of the change.
