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

// Order matters only as the server's own preference, used when the client's
// header leaves two candidates genuinely tied -- `Accept: */*` gives both
// document types the same weight from the same range. did+ld+json first keeps
// that case answering exactly as it did before.
const SUPPORTED = [DID_LD_JSON, DID_JSON, DID_RESOLUTION];

// Parse an Accept header into [{ media, q, order }]. Malformed q values count as
// 0, which is how RFC 7231 treats a weight it cannot read.
function parseAccept(acceptHeader) {
  return (acceptHeader || '')
    .split(',')
    .map((part, order) => {
      const [rawMedia, ...params] = part.split(';');
      const media = rawMedia.trim().toLowerCase();
      let q = 1;

      for (const param of params) {
        const trimmed = param.trim().toLowerCase();
        if (trimmed.startsWith('q=')) {
          const parsed = Number.parseFloat(trimmed.slice(2));
          q = Number.isNaN(parsed) ? 0 : parsed;
        }
      }

      return { media, q, order };
    })
    .filter(range => range.media);
}

// RFC 7231 5.3.2: the most specific matching range supplies a candidate's
// quality -- not the highest q among matching ranges. Otherwise
// `application/did+ld+json;q=0, */*;q=1` would take q=1 from the wildcard and
// serve the type the client just excluded.
function qualityFor(ranges, candidate) {
  const specificity = range =>
    range.media === candidate ? 3
      // A wildcard offers the document representations, never the result
      // envelope: `Accept: */*` must keep meaning what it meant before.
      //
      // Belt and braces rather than load-bearing -- SUPPORTED lists the document
      // types first, so the envelope already loses every wildcard tie. Removing
      // this line changes no observable behaviour today. Kept because the two
      // mechanisms guard the same thing for different reasons, and a future
      // reordering of SUPPORTED should not quietly hand `*/*` the envelope.
      : candidate === DID_RESOLUTION ? 0
        : range.media === 'application/*' ? 2
          : range.media === '*/*' ? 1
            : 0;

  let best;
  for (const range of ranges) {
    const rank = specificity(range);
    if (!rank) continue;
    if (!best || rank > best.rank || (rank === best.rank && range.order < best.order)) {
      best = { rank, q: range.q, order: range.order };
    }
  }

  return best;
}

// What to ask the gatekeeper for.
//
// Deliberately NOT 406 on a media type this driver does not know, even though
// the gatekeeper now does that: the Universal Resolver sends Accept headers
// whose conventions we do not control, and a driver that rejects one it has not
// been taught about is worse than one that answers with a representation the
// caller can read. A client that wants strict negotiation should talk to the
// gatekeeper directly.
//
// A client that explicitly excludes everything we support is a different case,
// and handled below.
function pickRepresentation(acceptHeader) {
  const ranges = parseAccept(acceptHeader);
  if (!ranges.length) return DID_LD_JSON;

  const scored = SUPPORTED
    .map(media => ({ media, hit: qualityFor(ranges, media) }))
    .filter(entry => entry.hit);

  const acceptable = scored.filter(entry => entry.hit.q > 0);

  if (acceptable.length) {
    return acceptable.reduce((best, entry) =>
      entry.hit.q > best.hit.q || (entry.hit.q === best.hit.q && entry.hit.order < best.hit.order)
        ? entry
        : best
    ).media;
  }

  // Nothing we support is acceptable. If the client never mentioned any of our
  // types, it asked for something unknown -- answer with the default. If it
  // named them and set q=0, it refused them, and forwarding the header lets the
  // gatekeeper say so with a 406 that this driver relays.
  return scored.length ? acceptHeader : DID_LD_JSON;
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

// Only listen when run directly, so the tests can mount the app on an ephemeral
// port instead of racing the real one.
if (require.main === module) {
  app.listen(PORT, () => console.log(`did:cid driver v${version} on :${PORT} → ${GATEKEEPER_URL}`));
}

module.exports = app;
