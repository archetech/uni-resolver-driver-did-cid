const express = require('express');
const { version } = require('./package.json');
const app = express();

const PORT = process.env.PORT || 4250;
const GATEKEEPER_URL = process.env.ARCHON_GATEKEEPER_URL || 'https://archon.technology';

// Media types this driver understands.
//
// did+ld+json and did+json describe a DID *document*; a resolution result is the
// {didDocument, didResolutionMetadata, didDocumentMetadata} triple, for which the
// DID Resolution binding specifies application/did-resolution. This driver used
// to label the triple with a document type in every case, reproducing the
// gatekeeper's own deviation outward -- so fixing the gatekeeper alone changed
// nothing that a Universal Resolver client could see. See archetech/archon#770.
const DID_LD_JSON = 'application/did+ld+json';
const DID_JSON = 'application/did+json';
const DID_RESOLUTION = 'application/did-resolution';

// What to ask the gatekeeper for. A client gets what it names; anything else --
// absent, a wildcard, or a media type this driver does not know -- keeps the
// existing did+ld+json default.
//
// Deliberately NOT 406 on an unknown type, even though the gatekeeper now does
// that: the Universal Resolver sends Accept headers whose conventions we do not
// control, and a driver that rejects one it has not been taught about is worse
// than one that answers with a representation the caller can read. A client that
// wants strict negotiation should talk to the gatekeeper directly.
function pickRepresentation(acceptHeader) {
  const accept = (acceptHeader || '').toLowerCase();
  // Most specific first: did+json is not a substring of did+ld+json, but
  // did-resolution must be checked before either so an explicit request for the
  // result envelope is not shadowed by a document type in the same header.
  if (accept.includes(DID_RESOLUTION)) return DID_RESOLUTION;
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

  // Label the response the way the gatekeeper labelled it. Deriving from
  // didResolutionMetadata.contentType instead was the bug: that field reports the
  // representation of the DID *document* inside the envelope, so using it as the
  // HTTP Content-Type describes the body as a document when it is a triple.
  const upstreamContentType = upstream.headers.get('content-type');
  const contentType = upstreamContentType
    ? upstreamContentType.split(';')[0].trim()
    : (result?.didResolutionMetadata?.contentType || accept);

  // Vary, because the response was selected by Accept.
  res.vary('Accept');
  res.status(status).type(error ? DID_LD_JSON : contentType).json(result);
});

// Methods endpoint
app.get('/1.0/methods', (req, res) => res.json(['cid']));

app.listen(PORT, () => console.log(`did:cid driver v${version} on :${PORT} → ${GATEKEEPER_URL}`));
