const express = require('express');
const { version } = require('./package.json');
const app = express();

const PORT = process.env.PORT || 4250;
const GATEKEEPER_URL = process.env.ARCHON_GATEKEEPER_URL || 'https://archon.technology';

// Representations this driver understands; anything else falls back to did+ld+json.
const DID_LD_JSON = 'application/did+ld+json';
const DID_JSON = 'application/did+json';

const IDENTIFIERS_PREFIX = '/1.0/identifiers/';

// Choose the representation to request from (and return to) the client.
function pickRepresentation(acceptHeader) {
  const accept = (acceptHeader || '').toLowerCase();
  // did+json is not a substring of did+ld+json, so this match is unambiguous.
  if (accept.includes(DID_JSON)) return DID_JSON;
  return DID_LD_JSON;
}

// Archon returns HTTP 200 with any failure carried in the result metadata
// (per the DID Resolution spec), so translate that error into the HTTP status
// the Universal Resolver expects from a driver.
function statusForError(error) {
  switch (error) {
    case 'invalidDid': return 400;
    case 'notFound': return 404;
    case 'representationNotSupported': return 406;
    case 'methodNotSupported': return 501;
    default: return 500;
  }
}

function errorResult(error, errorMessage) {
  return {
    didResolutionMetadata: errorMessage ? { error, errorMessage } : { error },
    didDocument: null,
    didDocumentMetadata: {}
  };
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', driver: 'did:cid', version, gatekeeper: GATEKEEPER_URL });
});

// Methods endpoint
app.get('/1.0/methods', (req, res) => res.json(['cid']));

// DID Resolution and DID-URL dereferencing — proxy to the Archon Universal
// Resolver-style endpoint. The full DID URL (path + query string) is passed
// through unchanged so that version queries (?versionId, ?versionTime,
// ?service) and dereferencing paths (did:cid:.../data, .../registration) reach
// the gatekeeper, which already returns a full DID Resolution / Dereferencing
// Result. The route is a wildcard because a DID URL path contains "/".
app.get('/1.0/identifiers/*', async (req, res) => {
  // Raw tail after the prefix: DID URL path + query, exactly as the client sent
  // it (so the gatekeeper receives the client's own encoding verbatim).
  const tail = req.originalUrl.slice(req.originalUrl.indexOf(IDENTIFIERS_PREFIX) + IDENTIFIERS_PREFIX.length);

  // The DID itself (before any path, query or fragment) must be did:cid.
  const didPart = tail.split(/[/?#]/)[0];
  let did;
  try { did = decodeURIComponent(didPart); } catch { did = didPart; }
  if (!did.startsWith('did:cid:')) {
    return res.status(400).type(DID_LD_JSON).json(errorResult('invalidDid'));
  }

  const accept = pickRepresentation(req.get('Accept'));

  let upstream;
  try {
    upstream = await fetch(`${GATEKEEPER_URL}${IDENTIFIERS_PREFIX}${tail}`, {
      headers: { Accept: accept }
    });
  } catch (error) {
    return res.status(502).type(DID_LD_JSON).json(errorResult('internalError', error.message));
  }

  let result;
  try {
    result = await upstream.json();
  } catch (error) {
    return res
      .status(502)
      .type(DID_LD_JSON)
      .json(errorResult('internalError', `gatekeeper returned a non-JSON response (${upstream.status})`));
  }

  // Resolution carries didResolutionMetadata; DID-URL dereferencing carries
  // dereferencingMetadata. Relay the result verbatim and derive the HTTP status
  // from whichever error is present (else fall back to the upstream status).
  const meta = result?.didResolutionMetadata || result?.dereferencingMetadata || {};
  const error = meta.error;
  const status = error ? statusForError(error) : (upstream.ok ? 200 : 502);
  const contentType = meta.contentType || upstream.headers.get('content-type') || accept;

  res.status(status).type(error ? DID_LD_JSON : contentType).json(result);
});

app.listen(PORT, () => console.log(`did:cid driver v${version} on :${PORT} → ${GATEKEEPER_URL}`));
