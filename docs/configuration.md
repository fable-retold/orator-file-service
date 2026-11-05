# Configuration

Register the service with your Orator application, then add a file route with a resolver:

```javascript
const libOratorFileService = require('orator-file-service');

// Register with a Fable that already has an Orator instance (fable.Orator):
fable.serviceManager.addAndInstantiateServiceProvider('OratorFileService',
    { CacheDirectory: '/var/cache/files' }, libOratorFileService);

fable.OratorFileService.addFileRoute(
{
    Route:       '/1.0/Depot/File/:id/Open',
    EnableTiles: true,                              // also mount the Deep Zoom tile route
    TileRoute:   '/1.0/Depot/File/:id/Tiles/*',
    Resolver:    (pRequest, fCallback) =>
    {
        // Host-owned: check auth + tenancy, map the request id to a path.
        return fCallback(null, { Allowed: true, AbsolutePath: '/data/library/42.mp4', MIMEType: 'video/mp4' });
    }
});
```

The DZI URL to hand OpenSeaDragon / `pict-section-fileview` is then `/1.0/Depot/File/<id>/Tiles/image.dzi`.

## `addTileRoute(options)` — tiles only (when the host already serves bytes)

If your application already has its own owner-scoped download/`Open` route, you don't want this service
registering a second bytes route — you only want its Deep Zoom pyramids. `addTileRoute` mounts **just** the tile
route, with the same `Resolver` seam mapping the request to an absolute source-image path:

```javascript
fable.OratorFileService.addTileRoute(
{
    TileRoute: '/1.0/Depot/File/:IDStoredFile/Tiles/*',
    Strategy:  'auto',
    Resolver:  (pRequest, fCallback) =>
    {
        // Same host-owned auth + tenancy + id->path mapping as the app's own Open route.
        return fCallback(null, { Allowed: true, AbsolutePath: '/data/library/huge.png' });
    }
});
```

This is how [Sluice](https://github.com/fable-retold/) wires deep zoom: its depot still streams bytes from
`GET /1.0/Depot/File/:IDStoredFile/Open`, and the tile route reuses the *same* scope + path resolver so tenancy
stays identical across both.

| Key | Default | Meaning |
|---|---|---|
| `TileRoute` | — | The tile route pattern (restify splat, e.g. `/x/:id/Tiles/*`). |
| `Resolver` | — | The same `(request, callback) => callback(err, { Allowed, AbsolutePath })` seam as `addFileRoute`. |
| `Strategy` | `'auto'` | `'auto'` pre-bakes then serves statically (falling back to on-the-fly); `'prebake'` / `'onthefly'` force one path. |

## `addFileRoute(options)`

| Key | Default | Meaning |
|---|---|---|
| `Route` | — | The Orator route pattern for byte serving (supports `:params` and `*` splats). |
| `Resolver` | — | `(request, callback) => callback(err, { Allowed, AbsolutePath, MIMEType?, DownloadName? })`. The tenancy/identity/path seam. |
| `EnableTiles` | `false` | Also register the Deep Zoom tile route. |
| `TileRoute` | `Route + '/Tiles/*'` | Override the tile route pattern. |
| `Strategy` | `'auto'` | `'auto'` pre-bakes then serves statically (falling back to on-the-fly); `'prebake'` / `'onthefly'` force one path. |
| `CacheControl` | — | The `Cache-Control` header for served bytes/tiles. |

## The resolver result

| Field | Meaning |
|---|---|
| `Allowed` | `false` → the service answers `403` and never touches disk. |
| `AbsolutePath` | The file to serve. A missing file answers `404`. |
| `MIMEType` | Optional explicit content type (otherwise inferred from the extension). |
| `DownloadName` | Optional `Content-Disposition` filename hint. |

## Building blocks (standalone)

Each block is exported for use without the full service:

```javascript
const { FileRangeServer, FileTileService, FileDerivativeCache } = require('orator-file-service');

// Pure range planning:
const plan = FileRangeServer.planByteRange(168342, 'bytes=0-1023');
// → { Satisfiable, Partial, Status, Start, End, Length, ContentRange }

// Stream a file with Range support:
FileRangeServer.serveFile(response, '/path/to/file', { MIMEType, DownloadName, CacheControl }, callback);

// DZI geometry (pure):
FileTileService.describePyramid(width, height, 254, 1);
```

## Tiling + dependencies

- Hard dependencies: `fable-serviceproviderbase` + `mime`.
- **Optional** dependency: `retold-sharp` (libvips). Tiling is capability-gated — when `retold-sharp` is absent,
  tile routes answer `501` and byte serving is unaffected.
- libvips `dzsave` streams the decode and writes tiles incrementally, so memory stays bounded at any image size.
- Produced pyramids are DZI (`image.dzi` + `image_files/<level>/<col>_<row>.jpeg`), the tile source
  [`pict-section-fileview`](https://fable-retold.github.io/pict-section-fileview/)'s deep-zoom lens consumes via
  OpenSeaDragon.
