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
    // Absent, wildcard, or a type this driver was never taught. Deliberately not
    // a 406: the Universal Resolver sends headers whose conventions the driver
    // does not control, and answering with something readable beats refusing.
    for (const accept of [undefined, '*/*', 'application/*', 'application/xml']) {
        await resolve(accept);
        assert.equal(lastRequest.accept, 'application/did+ld+json', `Accept: ${accept}`);
    }
});

test('prefers the resolution envelope when a header names it alongside a document type', async () => {
    reply = () => ({ status: 200, contentType: 'application/did-resolution', body: {} });
    await resolve('application/did+ld+json, application/did-resolution');

    assert.equal(lastRequest.accept, 'application/did-resolution');
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
