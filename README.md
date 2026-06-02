# Universal Resolver Driver: did:cid

A [Universal Resolver](https://github.com/decentralized-identity/universal-resolver) driver for the
**did:cid** method, used by the [Archon Protocol](https://archon.technology).

This driver resolves `did:cid` identifiers by proxying resolution requests to an Archon **gatekeeper**
node and returning a W3C [DID Resolution Result](https://w3c.github.io/did-resolution/#did-resolution-result).

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
- Archon Protocol: <https://archon.technology>
- W3C DID Core 1.0: <https://www.w3.org/TR/did-core/>
- DID Resolution: <https://w3c.github.io/did-resolution/>

> **Note:** `did:cid` is not yet listed in the
> [W3C DID Method Registry](https://w3c.github.io/did-spec-registries/#did-methods). Registration is
> in progress; see the PR checklist before this driver is merged into the default configuration.

## Example DIDs

```
did:cid:bagaaieraxdxq4fm2kjh6yqjxjor3t2idczkmxd4v7in4u353fa6m6sms2pnq
did:cid:bagaaierajzwcicueqdkbgk75lgekdmvtbo5zv3spq2p4f7d7ow42urlwi32a
```

## Driver Interface

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/1.0/identifiers/{did}` | GET | Resolve a `did:cid` and return a DID Resolution Result (`application/did+ld+json`). |
| `/1.0/methods` | GET | List supported DID methods — returns `["cid"]`. |
| `/health` | GET | Liveness probe — returns `{ status, driver, version, gatekeeper }`. |

The driver returns standard DID Resolution metadata errors:

| Condition | HTTP status | `didResolutionMetadata.error` |
|-----------|-------------|-------------------------------|
| DID does not start with `did:cid:` | 400 | `invalidDid` |
| Gatekeeper has no record for the DID | 404 | `notFound` |
| Gatekeeper unreachable / non-2xx | 502 | `internalError` |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4250` | Port the driver listens on. |
| `ARCHON_GATEKEEPER_URL` | `https://archon.technology` | Base URL of the Archon gatekeeper. The driver calls `${ARCHON_GATEKEEPER_URL}/api/v1/did/{did}`. |

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

The Universal Resolver pulls this driver as a public container image. To publish a release to GHCR:

```bash
# Build for the version you're releasing (must match package.json "version")
docker build -t ghcr.io/archetech/uni-resolver-driver-did-cid:0.1.0 .

# Authenticate to GHCR with a token that has the write:packages scope
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-username> --password-stdin

docker push ghcr.io/archetech/uni-resolver-driver-did-cid:0.1.0
```

**One-time step (org owner):** after the first push, open the package at
`https://github.com/orgs/archetech/packages` and set its visibility to **Public** — the Universal
Resolver cannot pull a private image. Later pushes to the same package stay public.

## Updating the Driver

Driver versions track the Docker image tag (never `:latest` in the Universal Resolver config). To
release a new version: bump `version` in `package.json`, build and push the image with the new tag
(above), and update the image reference in the Universal Resolver's `docker-compose.yml` and the
driver table in its root `README.md`.

## Contact

- **Maintainer:** Archetech (Archon Protocol)
- **GitHub:** <https://github.com/archetech/archon>
- **Email:** contact@archetech.com

## License

Apache License 2.0.
