'use strict';

// Node's built-in runner, so the driver keeps express as its only dependency.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const DID = 'did:cid:bagaaierabcdefghijklmnopqrstuvwxyz234567';

// A stand-in gatekeeper whose reply each test sets. Started before the driver is
// required, because the driver reads ARCHON_GATEKEEPER_URL at module load.
let reply = () => ({ status: 200, contentType: 'application/did+ld+json', body: {} });
let lastRequest = null;

const gatekeeper = http.createServer((req, res) => {
    lastRequest = { url: req.url, accept: req.headers.accept };
    const { status, contentType, body, raw } = reply(req);
    res.writeHead(status, { 'content-type': contentType, vary: 'Accept' });
    res.end(raw !== undefined ? raw : JSON.stringify(body));
});

let driver;
let baseUrl;

test.before(async () => {
    await new Promise(resolve => gatekeeper.listen(0, '127.0.0.1', resolve));
    process.env.ARCHON_GATEKEEPER_URL = `http://127.0.0.1:${gatekeeper.address().port}`;

    const app = require('../server.js');
    driver = app.listen(0, '127.0.0.1');
    await new Promise(resolve => driver.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${driver.address().port}`;
});

test.after(async () => {
    await new Promise(resolve => driver.close(resolve));
    await new Promise(resolve => gatekeeper.close(resolve));
});

test.beforeEach(() => {
    lastRequest = null;
    reply = () => ({
        status: 200,
        contentType: 'application/did+ld+json',
        body: {
            didDocument: { id: DID },
            didResolutionMetadata: { contentType: 'application/did+ld+json' },
            didDocumentMetadata: {},
        },
    });
});

function resolve(accept) {
    return fetch(`${baseUrl}/1.0/identifiers/${DID}`, {
        headers: accept ? { Accept: accept } : {},
    });
}

// fetch() always sends an Accept header -- `*/*` when the caller gives none --
// so a truly absent header needs the raw client. Without this the "no Accept"
// case silently re-tests the wildcard.
function resolveWithoutAccept() {
    return new Promise((resolve, reject) => {
        const request = http.request(
            `${baseUrl}/1.0/identifiers/${DID}`,
            { method: 'GET', setHost: true },
            response => {
                let body = '';
                response.on('data', chunk => { body += chunk; });
                response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
            }
        );
        request.on('error', reject);
        request.end();
    });
}

// The media type a client asks for is the one forwarded upstream. Before this,
// pickRepresentation understood only the two document types, so a request for the
// resolution envelope was silently downgraded and the driver reproduced the
// gatekeeper's own mislabelling outward. archetech/archon#770.
test('forwards the representation the client asked for', async () => {
    const cases = [
        ['application/did-resolution', 'application/did-resolution'],
        ['application/did+json', 'application/did+json'],
        ['application/did+ld+json', 'application/did+ld+json'],
    ];

    for (const [accept, forwarded] of cases) {
        reply = () => ({ status: 200, contentType: forwarded, body: { didResolutionMetadata: {} } });
        const response = await resolve(accept);

        assert.equal(lastRequest.accept, forwarded, `Accept: ${accept}`);
        assert.equal(response.headers.get('content-type').split(';')[0], forwarded);
    }
});

test('defaults to did+ld+json when the client names nothing it knows', async () => {
    // Wildcards, or a type this driver was never taught. Deliberately not a 406:
    // the Universal Resolver sends headers whose conventions the driver does not
    // control, and answering with something readable beats refusing.
    for (const accept of ['*/*', 'application/*', 'application/xml']) {
        await resolve(accept);
        assert.equal(lastRequest.accept, 'application/did+ld+json', `Accept: ${accept}`);
    }
});

test('defaults to did+ld+json when there is no Accept header at all', async () => {
    const response = await resolveWithoutAccept();

    assert.equal(response.status, 200);
    assert.equal(lastRequest.accept, 'application/did+ld+json');
});

test('honours q-values rather than the order types appear in', async () => {
    // Substring matching used to take the first type it recognised, so a
    // deprioritised envelope beat a preferred document type.
    reply = () => ({ status: 200, contentType: 'application/did+json', body: {} });
    await resolve('application/did-resolution;q=0.2, application/did+json;q=0.9');
    assert.equal(lastRequest.accept, 'application/did+json');

    reply = () => ({ status: 200, contentType: 'application/did-resolution', body: {} });
    await resolve('application/did+json;q=0.3, application/did-resolution;q=0.8');
    assert.equal(lastRequest.accept, 'application/did-resolution');
});

test('treats q=0 as a refusal, not a preference', async () => {
    reply = () => ({ status: 200, contentType: 'application/did+json', body: {} });
    await resolve('application/did-resolution;q=0, application/did+json;q=1');

    assert.equal(lastRequest.accept, 'application/did+json');
});

test('lets a wildcard supply quality only for the document types', async () => {
    // `*/*` must never select the result envelope, whatever its weight --
    // otherwise every lenient Universal Resolver client would start receiving
    // application/did-resolution.
    reply = () => ({ status: 200, contentType: 'application/did+ld+json', body: {} });
    await resolve('*/*;q=1, application/did+json;q=0.5');
    assert.equal(lastRequest.accept, 'application/did+ld+json');

    // A wildcard outranking an explicit document type. did+json is the right
    // answer -- it takes q=1 from `application/*` while did+ld+json is pinned at
    // 0.5 by its own entry -- and what matters here is that the envelope,
    // offered that same q=1, is not chosen.
    //
    // Pinned as behaviour, not as proof of the guard in qualityFor: SUPPORTED
    // lists the document types first, so the envelope loses these ties anyway.
    // Both mechanisms would have to go for this to break.
    await resolve('application/*;q=1, application/did+ld+json;q=0.5');
    assert.equal(lastRequest.accept, 'application/did+json');
});

test('lets an explicit q=0 exclude a type a wildcard would otherwise allow', async () => {
    // RFC 7231 5.3.2: the most specific matching range supplies the quality.
    // Taking the highest q across all matching ranges instead would hand the
    // excluded type q=1 from the wildcard and forward exactly what was refused.
    reply = () => ({ status: 200, contentType: 'application/did+json', body: {} });
    await resolve('application/did+ld+json;q=0, */*;q=1');

    assert.equal(lastRequest.accept, 'application/did+json');
});

test('defers to the gatekeeper when the client refuses everything it supports', async () => {
    // Not the default here: the client named our types and set q=0 on them.
    // Forwarding the header intact lets the gatekeeper answer 406, which this
    // driver relays -- rather than serving a representation that was refused.
    const accept = 'application/did-resolution;q=0, application/did+json;q=0, application/did+ld+json;q=0';
    reply = () => ({
        status: 406,
        contentType: 'application/json',
        body: { didDocument: null, didResolutionMetadata: { error: 'representationNotSupported' }, didDocumentMetadata: {} },
    });

    const response = await resolve(accept);

    assert.equal(lastRequest.accept, accept, 'forwards the header rather than choosing for the client');
    assert.equal(response.status, 406);
});

test('breaks an equal-weight tie by the order the client listed them', async () => {
    // Equal q means the client is indifferent, so first-listed wins. Predictable
    // and honest about the client's own ordering -- the previous substring match
    // always preferred the envelope regardless of where it appeared.
    reply = () => ({ status: 200, contentType: 'application/did-resolution', body: {} });
    await resolve('application/did-resolution, application/did+ld+json');
    assert.equal(lastRequest.accept, 'application/did-resolution');

    reply = () => ({ status: 200, contentType: 'application/did+ld+json', body: {} });
    await resolve('application/did+ld+json, application/did-resolution');
    assert.equal(lastRequest.accept, 'application/did+ld+json');
});

// The Content-Type must describe the body. didResolutionMetadata.contentType
// reports the representation of the DID document INSIDE the envelope, so using
// it as the header called a triple a document.
test('labels the response the way the gatekeeper labelled it', async () => {
    reply = () => ({
        status: 200,
        contentType: 'application/did-resolution',
        body: {
            didDocument: { id: DID },
            // Deliberately different from the header: this is what the old code
            // echoed, and what made the bug invisible.
            didResolutionMetadata: { contentType: 'application/did+ld+json' },
            didDocumentMetadata: {},
        },
    });

    const response = await resolve('application/did-resolution');

    assert.equal(response.headers.get('content-type').split(';')[0], 'application/did-resolution');
    const body = await response.json();
    assert.equal(body.didResolutionMetadata.contentType, 'application/did+ld+json');
});

test('sets Vary: Accept, because Accept selects the response', async () => {
    const response = await resolve('application/did+json');
    assert.match(response.headers.get('vary') || '', /Accept/);
});

test('maps a resolution error to the status the Universal Resolver expects', async () => {
    const cases = [
        ['invalidDid', 400],
        ['notFound', 404],
        ['representationNotSupported', 406],
        ['methodNotSupported', 501],
        ['somethingElse', 500],
    ];

    for (const [error, expected] of cases) {
        reply = () => ({
            status: 200,
            contentType: 'application/did+ld+json',
            body: { didDocument: null, didResolutionMetadata: { error }, didDocumentMetadata: {} },
        });

        const response = await resolve('application/did+ld+json');
        assert.equal(response.status, expected, error);
        // Errors are labelled did+ld+json whatever was negotiated, since the body
        // is the error result rather than the representation asked for.
        assert.equal(response.headers.get('content-type').split(';')[0], 'application/did+ld+json');
    }
});

test('relays a 406 from the gatekeeper', async () => {
    // The driver never sends an unsupported Accept upstream today, so this path
    // fires only if the gatekeeper rejects something the driver does forward.
    reply = () => ({
        status: 406,
        contentType: 'application/json',
        body: {
            didDocument: null,
            didResolutionMetadata: { error: 'representationNotSupported' },
            didDocumentMetadata: {},
        },
    });

    const response = await resolve('application/did+json');
    const body = await response.json();

    assert.equal(response.status, 406);
    assert.equal(body.didResolutionMetadata.error, 'representationNotSupported');
});

test('rejects a DID of another method without calling the gatekeeper', async () => {
    const response = await fetch(`${baseUrl}/1.0/identifiers/did:web:example.com`);
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.didResolutionMetadata.error, 'invalidDid');
    assert.equal(lastRequest, null, 'must not reach the gatekeeper');
});

test('answers 502 when the gatekeeper returns something that is not JSON', async () => {
    reply = () => ({ status: 200, contentType: 'text/html', raw: '<html>proxy error</html>' });

    const response = await resolve('application/did+ld+json');
    const body = await response.json();

    assert.equal(response.status, 502);
    assert.equal(body.didResolutionMetadata.error, 'internalError');
    assert.match(body.didResolutionMetadata.errorMessage, /non-JSON/);
});

test('serves health and the method list', async () => {
    const health = await (await fetch(`${baseUrl}/health`)).json();
    assert.equal(health.status, 'ok');
    assert.equal(health.driver, 'did:cid');

    const methods = await (await fetch(`${baseUrl}/1.0/methods`)).json();
    assert.deepEqual(methods, ['cid']);
});
