const express = require('express');
const { version } = require('./package.json');
const app = express();

const PORT = process.env.PORT || 4250;
const GATEKEEPER_URL = process.env.ARCHON_GATEKEEPER_URL || 'https://archon.technology';

// Representations this driver understands; anything else falls back to did+ld+json.
const DID_LD_JSON = 'application/did+ld+json';
const DID_JSON = 'application/did+json';

// Choose the representation to request from (and return to) the client.
function pickRepresentation(acceptHeader) {
  const accept = (acceptHeader || '').toLowerCase();
  // did+json is not a substring of did+ld+json, so this match is unambiguous.
  if (accept.includes(DID_JSON)) return DID_JSON;
  return DID_LD_JSON;
}

// Archon returns HTTP 200 with any failure carried in didResolutionMetadata.error
// (per the DID Resolution spec), so translate that error into the HTTP status the
// Universal Resolver expects from a driver.
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

// DID Resolution — proxy to the Archon Universal Resolver-style endpoint,
// which already returns a full W3C DID Resolution Result.
app.get('/1.0/identifiers/:did', async (req, res) => {
  const did = req.params.did;

  if (!did.startsWith('did:cid:')) {
    return res.status(400).type(DID_LD_JSON).json(errorResult('invalidDid'));
  }

  const accept = pickRepresentation(req.get('Accept'));

  let upstream;
  try {
    upstream = await fetch(`${GATEKEEPER_URL}/1.0/identifiers/${encodeURIComponent(did)}`, {
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

  // Relay the resolution result verbatim; derive the HTTP status from the result
  // (falling back to the upstream status if the gatekeeper does signal one).
  const error = result?.didResolutionMetadata?.error;
  const status = error ? statusForError(error) : (upstream.ok ? 200 : 502);
  const contentType = result?.didResolutionMetadata?.contentType || accept;

  res.status(status).type(error ? DID_LD_JSON : contentType).json(result);
});

// Methods endpoint
app.get('/1.0/methods', (req, res) => res.json(['cid']));

app.listen(PORT, () => console.log(`did:cid driver v${version} on :${PORT} → ${GATEKEEPER_URL}`));
