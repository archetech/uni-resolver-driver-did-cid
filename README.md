# Universal Resolver Driver: did:cid

A [Universal Resolver](https://github.com/decentralized-identity/universal-resolver) driver for the
**did:cid** method, used by the [Archon Protocol](https://archon.technology).

This driver resolves `did:cid` identifiers by proxying to an Archon **gatekeeper** node's Universal
Resolver-style `/1.0/identifiers/{did}` endpoint and relaying the W3C
[DID Resolution Result](https://w3c.github.io/did-resolution/#did-resolution-result) it returns.

## About did:cid

`did:cid` is a content-addressed DID method in which the DID identifier is derived from the IPFS CID
of the initial DID document. This provides:

- **Instant creation** — no blockchain transaction is required to create a DID.
- **Self-certifying** — the identifier cryptographically commits to the genesis document, so the DID
  proves its own integrity.
- **Multi-registry** — subsequent updates can be anchored to various registries (Hyperswarm, Bitcoin, etc.).

## Specifications

- DID Method name: `cid`
- DID Method Specification: [did:cid spec](https://github.com/archetech/archon/blob/main/docs/scheme.md)
- W3C DID Method Registry entry: [DID Extensions — Methods](https://www.w3.org/TR/did-extensions-methods/) (registered)
- Archon Protocol: <https://archon.technology>
- W3C DID Core 1.0: <https://www.w3.org/TR/did-core/>
- DID Resolution: <https://w3c.github.io/did-resolution/>

> **Note:** `did:cid` is registered in the W3C
> [DID Extensions — Methods](https://www.w3.org/TR/did-extensions-methods/) registry.

## Example DIDs

```
did:cid:bagaaieraxdxq4fm2kjh6yqjxjor3t2idczkmxd4v7in4u353fa6m6sms2pnq
did:cid:bagaaierajzwcicueqdkbgk75lgekdmvtbo5zv3spq2p4f7d7ow42urlwi32a
```

## Driver Interface

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/1.0/identifiers/{did}` | GET | Resolve a `did:cid` and return a DID Resolution Result. See [Content negotiation](#content-negotiation). |
| `/1.0/methods` | GET | List supported DID methods — returns `["cid"]`. |
| `/health` | GET | Liveness probe — returns `{ status, driver, version, gatekeeper }`. |

The gatekeeper returns a DID Resolution Result with any failure carried in
`didResolutionMetadata.error`; the driver relays the result and derives the HTTP status from it:

| Condition | HTTP status | `didResolutionMetadata.error` |
|-----------|-------------|-------------------------------|
| DID does not start with `did:cid:` (rejected locally) | 400 | `invalidDid` |
| Gatekeeper reports `invalidDid` | 400 | `invalidDid` |
| Gatekeeper has no record for the DID | 404 | `notFound` |
| Requested representation unavailable | 406 | `representationNotSupported` |
| Gatekeeper unreachable / non-JSON response | 502 | `internalError` |

## Content negotiation

| `Accept` | Returned `Content-Type` |
|----------|--------------------------|
| `application/did-resolution` | `application/did-resolution` |
| `application/did+json` | `application/did+json` |
| `application/did+ld+json`, a wildcard, absent, or anything else | `application/did+ld+json` |

`application/did+ld+json` and `application/did+json` are DID **document**
representation media types, while this endpoint returns the resolution result
triple. A client that wants the body labelled for what it is asks for
`application/did-resolution`. The document types stay the default, because that
is what Universal Resolver clients expect.

The `Content-Type` is whatever the gatekeeper returned, not a value derived from
`didResolutionMetadata.contentType` — that field describes the representation of
the DID document *inside* the envelope, so using it as the HTTP header describes
the body as a document when it is a triple.

An unrecognised `Accept` is answered with the default rather than `406`. The
gatekeeper is stricter, but the Universal Resolver sends headers whose
conventions this driver does not control, and refusing one it has not been
taught about is worse than answering with something the caller can read. A
`406` from the gatekeeper is still relayed as a `406`.

Responses set `Vary: Accept`.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4250` | Port the driver listens on. |
| `ARCHON_GATEKEEPER_URL` | `https://archon.technology` | Base URL of the Archon gatekeeper. The driver calls `${ARCHON_GATEKEEPER_URL}/1.0/identifiers/{did}`. |

## Running Locally (Node.js)

Requires Node.js 20+ (the driver uses the global `fetch` API).

```bash
npm install

# Start the driver against the public gatekeeper
PORT=4250 ARCHON_GATEKEEPER_URL=https://archon.technology npm start

# Resolve a DID
curl http://localhost:4250/1.0/identifiers/did:cid:bagaaieraxdxq4fm2kjh6yqjxjor3t2idczkmxd4v7in4u353fa6m6sms2pnq
```

## Running with Docker

```bash
# Build
docker build -t ghcr.io/archetech/uni-resolver-driver-did-cid:0.1.0 .

# Run
docker run -p 4250:4250 \
  -e ARCHON_GATEKEEPER_URL=https://archon.technology \
  ghcr.io/archetech/uni-resolver-driver-did-cid:0.1.0

# Resolve a DID
curl http://localhost:4250/1.0/identifiers/did:cid:bagaaieraxdxq4fm2kjh6yqjxjor3t2idczkmxd4v7in4u353fa6m6sms2pnq
```

The image includes a `HEALTHCHECK` that polls `/health` every 30s.

## Integration with the Universal Resolver

This driver is wired into the Universal Resolver across the three configuration files described in
[Driver Development](https://github.com/decentralized-identity/universal-resolver/blob/main/docs/driver-development.md).

`docker-compose.yml`:

```yaml
  driver-did-cid:
    image: ghcr.io/archetech/uni-resolver-driver-did-cid:0.1.0
    environment:
      ARCHON_GATEKEEPER_URL: ${uniresolver_driver_did_cid_gatekeeper_url}
    ports:
      - "4250:4250"
```

…plus an empty override entry under the `uni-resolver-web` service's `environment:` block:

```yaml
      uniresolver_web_driver_url_did_cid:
```

`uni-resolver-web/src/main/resources/application.yml`:

```yaml
    - pattern: "^(did:cid:.+)$"
      url: ${uniresolver_web_driver_url_did_cid:http://driver-did-cid:4250/1.0/identifiers/$1}
      testIdentifiers:
        - did:cid:bagaaieraxdxq4fm2kjh6yqjxjor3t2idczkmxd4v7in4u353fa6m6sms2pnq
        - did:cid:bagaaierajzwcicueqdkbgk75lgekdmvtbo5zv3spq2p4f7d7ow42urlwi32a
```

`.env`:

```bash
# did:cid (Archon Protocol)
uniresolver_driver_did_cid_gatekeeper_url=https://archon.technology
```

Once configured, resolve through the running resolver:

```bash
curl http://localhost:8080/1.0/identifiers/did:cid:bagaaieraxdxq4fm2kjh6yqjxjor3t2idczkmxd4v7in4u353fa6m6sms2pnq
```

## Troubleshooting

- **`internalError` / 502** — the driver could not reach the gatekeeper. Verify `ARCHON_GATEKEEPER_URL`
  is reachable from inside the container (`docker exec ... wget -qO- $ARCHON_GATEKEEPER_URL`).
- **`notFound` / 404** — the DID is well-formed but the gatekeeper has no record for it. Confirm the
  CID exists and the gatekeeper is synced.
- **`invalidDid` / 400** — the identifier does not begin with `did:cid:`.
- **Health check failing** — `curl http://localhost:4250/health`; a healthy response reports the
  configured `gatekeeper` URL.

## Publishing the Image

The Universal Resolver pulls this driver as a public container image
(`ghcr.io/archetech/uni-resolver-driver-did-cid`). Publishing is automated by
[`.github/workflows/publish.yml`](.github/workflows/publish.yml): pushing a `v<version>` tag builds
and pushes the image to GHCR under that version. The workflow refuses to run if the tag does not
match the `version` in `package.json`, and it never publishes `:latest` (the Universal Resolver
requires a pinned version).

Anyone with push access to this repo can cut a release — the workflow authenticates with the
built-in `GITHUB_TOKEN`, so no personal registry key is required:

```bash
# 1. Bump "version" in package.json (e.g. to 0.1.0) and commit it.
# 2. Tag the release and push the tag:
git tag v0.1.0
git push origin v0.1.0
```

It can also be run from the **Actions** tab via *workflow_dispatch* (optionally overriding the version).

**One-time step (org owner):** after the first publish, open the package at
`https://github.com/orgs/archetech/packages`, set its visibility to **Public**, and confirm it is
linked to this repository — the Universal Resolver cannot pull a private image. Later pushes stay
public.

<details>
<summary>Manual publish (fallback, requires a token with <code>write:packages</code>)</summary>

```bash
docker build -t ghcr.io/archetech/uni-resolver-driver-did-cid:0.1.0 .
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-username> --password-stdin
docker push ghcr.io/archetech/uni-resolver-driver-did-cid:0.1.0
```
</details>

## Updating the Driver

Driver versions track the Docker image tag (never `:latest` in the Universal Resolver config). To
release a new version: bump `version` in `package.json`, push a matching `v<version>` tag to publish
the image (see [Publishing the Image](#publishing-the-image)), and update the image reference in the
Universal Resolver's `docker-compose.yml` and the driver table in its root `README.md`.

## Contact

- **Maintainer:** Archetech (Archon Protocol)
- **GitHub:** <https://github.com/archetech/archon>
- **Email:** flaxscrip@pm.me

## License

Apache License 2.0.
