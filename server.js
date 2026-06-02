const express = require('express');
const app = express();

const PORT = process.env.PORT || 4250;
const GATEKEEPER_URL = process.env.ARCHON_GATEKEEPER_URL || 'https://archon.technology';

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', driver: 'did:cid', version: '0.1.0', gatekeeper: GATEKEEPER_URL });
});

// DID Resolution — proxy to gatekeeper
app.get('/1.0/identifiers/:did', async (req, res) => {
  const did = req.params.did;
  
  if (!did.startsWith('did:cid:')) {
    return res.status(400).json({
      didResolutionMetadata: { error: 'invalidDid' },
      didDocument: null,
      didDocumentMetadata: {}
    });
  }

  try {
    const response = await fetch(`${GATEKEEPER_URL}/api/v1/did/${encodeURIComponent(did)}`);

    if (response.status === 404) {
      return res.status(404).json({
        didResolutionMetadata: { error: 'notFound' },
        didDocument: null,
        didDocumentMetadata: {}
      });
    }

    if (!response.ok) {
      return res.status(502).json({
        didResolutionMetadata: { error: 'internalError', errorMessage: `gatekeeper responded ${response.status}` },
        didDocument: null,
        didDocumentMetadata: {}
      });
    }

    const result = await response.json();

    res.setHeader('Content-Type', 'application/did+ld+json');
    res.json(result);
  } catch (error) {
    res.status(502).json({
      didResolutionMetadata: { error: 'internalError', errorMessage: error.message },
      didDocument: null,
      didDocumentMetadata: {}
    });
  }
});

// Methods endpoint
app.get('/1.0/methods', (req, res) => res.json(['cid']));

app.listen(PORT, () => console.log(`did:cid driver on :${PORT} → ${GATEKEEPER_URL}`));
