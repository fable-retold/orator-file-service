# orator-file-service

A small, reusable [Orator](https://github.com/fable-retold/orator) service for serving **file bytes** over HTTP/1.1
with full `Range` support, plus — when [`retold-sharp`](https://github.com/fable-retold/retold-sharp) (libvips) is
available — image **derivatives** and **Deep Zoom (DZI) tile pyramids** for enormous images.

It is the serving spine the rest of the ecosystem shares:

- [`pict-section-fileview`](https://github.com/fable-retold/pict-section-fileview)'s deep-zoom lens points
  OpenSeaDragon at a DZI tile source produced here.
- Sluice and `retold-remote` can mount it to range-serve stored files without each re-implementing the HTTP
  byte-serving (and tiling) plumbing.

**It owns none of your identity, tenancy, or path model.** Every route is given a `Resolver(request, callback)` you
supply; the resolver maps a request to an absolute file path and an allow/deny decision. Tenancy stays in your
application layer, exactly where it belongs — this service only turns a resolved path into well-behaved bytes.

## Install

```bash
npm install orator-file-service
```

Hard dependencies are only `fable-serviceproviderbase` and `mime`. `retold-sharp` is an **optional** dependency: with
it, the service offers deep-zoom tiling; without it, tile routes answer `501` and byte serving is unaffected.

## Usage

```javascript
const libOratorFileService = require('orator-file-service');

// Register with a Fable that already has an Orator instance:
pFable.serviceManager.addAndInstantiateServiceProvider('OratorFileService',
    { CacheDirectory: '/var/cache/files' }, libOratorFileService);

pFable.OratorFileService.addFileRoute(
    {
        Route:       '/1.0/Depot/File/:id/Open',
        EnableTiles: true,
        TileRoute:   '/1.0/Depot/File/:id/Tiles/*',
        Resolver: (pRequest, fCallback) =>
        {
            // YOUR auth + id -> path mapping happens here (the tenancy seam).
            // Call back with { Allowed, AbsolutePath, MIMEType?, DownloadName? }.
            myApp.resolveFile(pRequest.params.id, pRequest, (pError, pFile) =>
            {
                if (pError) return fCallback(pError);
                return fCallback(null,
                    {
                        Allowed:      pFile.userMayRead,
                        AbsolutePath: pFile.path,
                        MIMEType:     pFile.mimeType
                    });
            });
        }
    });
```

The DZI tile source URL to hand OpenSeaDragon / `pict-section-fileview` is then
`/1.0/Depot/File/<id>/Tiles/image.dzi` — OpenSeaDragon fetches the sibling tiles (`.../Tiles/image_files/<level>/<col>_<row>.jpeg`)
automatically.

### Resolver contract

`Resolver(pRequest, fCallback)` → `fCallback(error, resolution)`, where `resolution` is:

| Field | Meaning |
|---|---|
| `Allowed` | `false` ⇒ the service answers `403`. The resolver is where you enforce tenancy/auth. |
| `AbsolutePath` | Absolute path on disk. Absent ⇒ `404`. |
| `MIMEType` | Optional explicit Content-Type (otherwise detected from the file name). |
| `DownloadName` | Optional — sets `Content-Disposition: attachment; filename="…"`. |

### `addFileRoute(options)`

| Key | Meaning |
|---|---|
| `Route` | The bytes route (restify pattern). Required. |
| `Resolver` | The resolver function above. Required. |
| `EnableTiles` | Also register a DZI tile route. |
| `TileRoute` | The tile route pattern (defaults to `Route + '/Tiles/*'`). Must end in a `*` splat. |
| `Strategy` | `'auto'` (default) · `'prebake'` · `'onthefly'` (see below). |
| `CacheControl` | `Cache-Control` for served bytes (defaults to the service config). |

Service config (second argument at registration): `CacheDirectory`, `TileSize` (254), `TileOverlap` (1),
`TileFormat` (`'jpeg'`), `TileQuality` (80), `DefaultCacheControl`.

## Deep-zoom tiling

The generator is libvips' `dzsave`, reached through `retold-sharp`'s `.tile({ layout: 'dz' })`. libvips is the most
performant option available: it streams the pyramid in a single pass with **bounded memory** — it does not decode the
whole gigapixel image into RAM, which is the entire point for 800 MB / giga-pixel inputs. `limitInputPixels: false` is
set so genuinely enormous sources are allowed.

Two strategies:

- **Pre-bake** (`'prebake'`, and the default half of `'auto'`): `dzsave` the full pyramid once into the derivative
  cache, keyed on `(source path, mtime, tile params)`, then static-serve the tiles as ordinary files (bytes, ranges,
  HTTP caching all free). Fastest repeat access, simplest wiring. A `.ready` marker guards against a crashed/partial
  generation being mistaken for a complete pyramid.
- **On-the-fly** (`'onthefly'`, and the fallback half of `'auto'`): crop + resize a single tile per request. No
  pyramid storage; higher per-tile cost. Best when the pyramid cannot be persisted, or the source is already
  pyramidal/random-access (pyramidal TIFF, SVS/OpenSlide), where libvips serves a region near-instantly.

> **Fastest repeat path for a giant _baseline_ JPEG** (no random access): transcode it to a pyramidal TIFF once, then
> `dzsave` — the pyramidal source turns the per-level decode from O(full image) into O(region).

## Building blocks

The pieces are also exported for hosts that want to wire their own routes:

```javascript
const { FileRangeServer, FileDerivativeCache, FileTileService } = require('orator-file-service');

FileRangeServer.serveFile(pResponse, '/abs/path.mp4', { RangeHeader: pReq.headers.range });
FileRangeServer.planByteRange(fileSize, 'bytes=500-999');     // pure Range arithmetic
FileTileService.describePyramid(width, height, 254, 1);       // pure Deep-Zoom geometry
```

## Development

```bash
npm test        # Mocha TDD via quackage
npm run tests   # Mocha directly (npx mocha -u tdd test/*.js)
```

The Range arithmetic and Deep-Zoom geometry are pure and always tested. The `dzsave`/on-the-fly tests require a
working `retold-sharp` (libvips) binary; when one is absent they **skip loudly** rather than silently passing.

MIT © Steven Velozo
