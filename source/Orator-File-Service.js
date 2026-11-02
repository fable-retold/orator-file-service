/**
* Orator File Service
*
* A small, reusable Orator service that serves file bytes over HTTP/1.1 with
* Range support, and -- when retold-sharp (libvips) is available -- image
* derivatives and Deep Zoom (DZI) tile pyramids for enormous images.
*
* It owns NONE of the host's identity, tenancy, or path model. Each route is
* given a `Resolver(request, callback)` the host supplies; the resolver maps a
* request to an absolute file path and an allow/deny decision. Tenancy stays in
* the host application layer, exactly where it belongs -- this service only
* turns a resolved path into well-behaved bytes.
*
* Usage:
*   const libOratorFileService = require('orator-file-service');
*   // Register with a Fable that already has an Orator instance:
*   pFable.serviceManager.addAndInstantiateServiceProvider('OratorFileService',
*       { CacheDirectory: '/var/cache/files' }, libOratorFileService);
*
*   pFable.OratorFileService.addFileRoute(
*       {
*           Route: '/1.0/Depot/File/:id/Open',
*           EnableTiles: true,
*           TileRoute: '/1.0/Depot/File/:id/Tiles/*',
*           Resolver: (pRequest, fCallback) =>
*           {
*               // host does auth + id->path here (this is the tenancy seam)
*               return fCallback(null, { Allowed: true, AbsolutePath: tmpPath, MIMEType: tmpType });
*           }
*       });
*
* The DZI URL to hand OpenSeaDragon / pict-section-fileview is then
* `/1.0/Depot/File/<id>/Tiles/image.dzi`.
*
* @license MIT
*
* @author Steven Velozo <steven@velozo.com>
*/

const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libPath = require('node:path');
const libFS = require('node:fs');

const libRangeServer = require('./File-Range-Server.js');
const libDerivativeCache = require('./File-Derivative-Cache.js');
const libTileService = require('./File-Tile-Service.js');

const _DefaultConfiguration =
{
	CacheDirectory: false,         // where derivatives/tiles are cached (defaults to OS tmp)
	TileSize: 254,
	TileOverlap: 1,
	TileFormat: 'jpeg',
	TileQuality: 80,
	DefaultCacheControl: 'public, max-age=3600'
};

class OratorFileService extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		let tmpOptions = Object.assign({}, _DefaultConfiguration, pOptions || {});
		super(pFable, tmpOptions, pServiceHash);

		this.serviceType = 'OratorFileService';
		this.routes = [];

		this._cache = false;
		this._tileService = false;
	}

	/**
	 * The lazily-built derivative cache.
	 * @returns {Object} FileDerivativeCache
	 */
	get cache()
	{
		if (!this._cache)
		{
			let tmpCacheDirectory = this.options.CacheDirectory
				|| libPath.join(require('node:os').tmpdir(), 'orator-file-service-cache');
			this._cache = new libDerivativeCache({ CacheDirectory: tmpCacheDirectory });
		}
		return this._cache;
	}

	/**
	 * The lazily-built tile service (capability-gated on retold-sharp).
	 * @returns {Object} FileTileService
	 */
	get tileService()
	{
		if (!this._tileService)
		{
			this._tileService = new libTileService(
				{
					Cache: this.cache,
					TileSize: this.options.TileSize,
					Overlap: this.options.TileOverlap,
					Format: this.options.TileFormat,
					Quality: this.options.TileQuality,
					Log: this.log
				});
		}
		return this._tileService;
	}

	/**
	 * @returns {boolean} true when deep-zoom tiling is available on this host.
	 */
	tilesAvailable()
	{
		return this.tileService.available();
	}

	/**
	 * Register a file route (and optionally its tile route) on the Orator server.
	 *
	 * @param {Object} pRouteOptions
	 * @param {string} pRouteOptions.Route - The bytes route (restify pattern).
	 * @param {function} pRouteOptions.Resolver - Resolver(request, callback(err, { Allowed, AbsolutePath, MIMEType?, DownloadName? })).
	 * @param {boolean} [pRouteOptions.EnableTiles] - Also register a DZI tile route.
	 * @param {string} [pRouteOptions.TileRoute] - The tile route pattern (defaults to Route + '/Tiles/*').
	 * @param {string} [pRouteOptions.Strategy='auto'] - 'prebake' | 'onthefly' | 'auto'.
	 * @param {string} [pRouteOptions.CacheControl] - Cache-Control for served bytes.
	 * @returns {boolean} true if registered.
	 */
	addFileRoute(pRouteOptions)
	{
		let tmpOptions = pRouteOptions || {};

		if (!this.fable.Orator || !this.fable.Orator.serviceServer)
		{
			this.log.error('OratorFileService requires an Orator instance registered with Fable.');
			return false;
		}
		if (typeof tmpOptions.Resolver !== 'function')
		{
			this.log.error('OratorFileService.addFileRoute requires a Resolver function.');
			return false;
		}
		if (typeof tmpOptions.Route !== 'string')
		{
			this.log.error('OratorFileService.addFileRoute requires a Route string.');
			return false;
		}

		let tmpServer = this.fable.Orator.serviceServer;

		tmpServer.get(tmpOptions.Route, (pRequest, pResponse, fNext) =>
		{
			return this._handleFileRequest(tmpOptions, pRequest, pResponse, fNext);
		});

		let tmpRecord = { Route: tmpOptions.Route, EnableTiles: !!tmpOptions.EnableTiles };

		if (tmpOptions.EnableTiles)
		{
			let tmpTileRoute = tmpOptions.TileRoute || (tmpOptions.Route.replace(/\/+$/, '') + '/Tiles/*');
			tmpRecord.TileRoute = tmpTileRoute;
			tmpOptions._TileMarker = this._tileMarkerFor(tmpTileRoute);

			tmpServer.get(tmpTileRoute, (pRequest, pResponse, fNext) =>
			{
				return this._handleTileRequest(tmpOptions, pRequest, pResponse, fNext);
			});
		}

		this.routes.push(tmpRecord);
		this.log.info(`OratorFileService mapped file route ${tmpOptions.Route}${tmpOptions.EnableTiles ? ' (+tiles)' : ''}`);
		return true;
	}

	// -----------------------------------------------------------------
	// Request handlers
	// -----------------------------------------------------------------

	_handleFileRequest(pRouteOptions, pRequest, pResponse, fNext)
	{
		let tmpNext = (typeof fNext === 'function') ? fNext : () => {};
		pRouteOptions.Resolver(pRequest, (pError, pResolution) =>
		{
			if (pError)
			{
				this._sendError(pResponse, 500, pError.message);
				return tmpNext();
			}
			if (!pResolution || pResolution.Allowed === false)
			{
				this._sendError(pResponse, 403, 'Forbidden.');
				return tmpNext();
			}
			if (!pResolution.AbsolutePath)
			{
				this._sendError(pResponse, 404, 'Not found.');
				return tmpNext();
			}

			libRangeServer.serveFile(pResponse, pResolution.AbsolutePath,
				{
					RangeHeader: (pRequest.headers || {}).range,
					Method: pRequest.method,
					MIMEType: pResolution.MIMEType,
					DownloadName: pResolution.DownloadName,
					CacheControl: pRouteOptions.CacheControl || this.options.DefaultCacheControl
				},
				(pServeError) =>
				{
					if (pServeError)
					{
						this._sendError(pResponse, 404, 'Not found.');
					}
					return tmpNext();
				});
		});
	}

	_handleTileRequest(pRouteOptions, pRequest, pResponse, fNext)
	{
		let tmpNext = (typeof fNext === 'function') ? fNext : () => {};

		if (!this.tilesAvailable())
		{
			this._sendError(pResponse, 501, 'Deep-zoom tiling is not available on this server.');
			return tmpNext();
		}

		let tmpSubPath = this._extractTileSubPath(pRouteOptions, pRequest);
		if (!tmpSubPath)
		{
			this._sendError(pResponse, 404, 'No tile path.');
			return tmpNext();
		}

		pRouteOptions.Resolver(pRequest, (pError, pResolution) =>
		{
			if (pError)
			{
				this._sendError(pResponse, 500, pError.message);
				return tmpNext();
			}
			if (!pResolution || pResolution.Allowed === false)
			{
				this._sendError(pResponse, 403, 'Forbidden.');
				return tmpNext();
			}
			if (!pResolution.AbsolutePath)
			{
				this._sendError(pResponse, 404, 'Not found.');
				return tmpNext();
			}

			let tmpStrategy = pRouteOptions.Strategy || 'auto';

			if (tmpStrategy === 'onthefly')
			{
				return this._serveTileOnTheFly(pResolution.AbsolutePath, tmpSubPath, pRequest, pResponse, tmpNext);
			}

			// Pre-bake (default): generate-or-reuse the pyramid, then static-serve.
			this.tileService.ensurePyramid(pResolution.AbsolutePath, (pGenError, pLayout) =>
			{
				if (pGenError)
				{
					if (tmpStrategy === 'prebake')
					{
						this.log.error(`DZI pre-bake failed for ${pResolution.AbsolutePath}: ${pGenError.message}`);
						this._sendError(pResponse, 500, 'Tile generation failed.');
						return tmpNext();
					}
					// auto -> fall back to on-the-fly for this request.
					this.log.warn(`DZI pre-bake failed, falling back to on-the-fly: ${pGenError.message}`);
					return this._serveTileOnTheFly(pResolution.AbsolutePath, tmpSubPath, pRequest, pResponse, tmpNext);
				}

				return this._serveTileFromDirectory(pLayout.DirectoryPath, tmpSubPath, pRequest, pResponse, tmpNext);
			});
		});
	}

	// -----------------------------------------------------------------
	// Tile serving helpers
	// -----------------------------------------------------------------

	/**
	 * Serve a pre-baked tile/descriptor as a static file, with a path-traversal
	 * guard that confines reads to the pyramid directory.
	 */
	_serveTileFromDirectory(pDirectory, pSubPath, pRequest, pResponse, fNext)
	{
		let tmpTarget = libPath.resolve(pDirectory, pSubPath);
		let tmpRoot = libPath.resolve(pDirectory);
		if (tmpTarget !== tmpRoot && !tmpTarget.startsWith(tmpRoot + libPath.sep))
		{
			this._sendError(pResponse, 403, 'Path traversal rejected.');
			return fNext();
		}

		libRangeServer.serveFile(pResponse, tmpTarget,
			{
				RangeHeader: (pRequest.headers || {}).range,
				Method: pRequest.method,
				MIMEType: tmpTarget.endsWith('.dzi') ? 'application/xml' : undefined,
				CacheControl: this.options.DefaultCacheControl
			},
			(pServeError) =>
			{
				if (pServeError)
				{
					this._sendError(pResponse, 404, 'Tile not found.');
				}
				return fNext();
			});
	}

	/**
	 * Serve a DZI descriptor or a single tile generated on demand (no pyramid
	 * persisted). Parses the DZI sub-path to find the level/col/row.
	 */
	_serveTileOnTheFly(pSourcePath, pSubPath, pRequest, pResponse, fNext)
	{
		// Descriptor request: ".../image.dzi"
		if (pSubPath.endsWith('.dzi'))
		{
			return this.tileService.probeDimensions(pSourcePath, (pError, pDimensions) =>
			{
				if (pError)
				{
					this._sendError(pResponse, 404, 'Not an image.');
					return fNext();
				}
				let tmpXML = libTileService.dziDescriptorXML(
					pDimensions.Width, pDimensions.Height,
					this.options.TileSize, this.options.TileOverlap, this.options.TileFormat);
				this._sendBuffer(pResponse, 200, 'application/xml', Buffer.from(tmpXML, 'utf8'));
				return fNext();
			});
		}

		// Tile request: ".../image_files/<level>/<col>_<row>.<ext>"
		let tmpMatch = (/(\d+)\/(\d+)_(\d+)\.[A-Za-z0-9]+$/).exec(pSubPath);
		if (!tmpMatch)
		{
			this._sendError(pResponse, 404, 'Unrecognized tile path.');
			return fNext();
		}

		let tmpLevel = parseInt(tmpMatch[1], 10);
		let tmpColumn = parseInt(tmpMatch[2], 10);
		let tmpRow = parseInt(tmpMatch[3], 10);

		this.tileService.renderTile(pSourcePath, tmpLevel, tmpColumn, tmpRow, (pError, pResult) =>
		{
			if (pError)
			{
				this._sendError(pResponse, 404, 'Tile not available.');
				return fNext();
			}
			this._sendBuffer(pResponse, 200, pResult.ContentType, pResult.Buffer);
			return fNext();
		});
	}

	// -----------------------------------------------------------------
	// Small response + path utilities
	// -----------------------------------------------------------------

	/**
	 * Derive the static marker segment ('/Tiles/') from a tile route pattern so
	 * the tile sub-path can be recovered from a request URL when the server's
	 * splat param is unavailable.
	 */
	_tileMarkerFor(pTileRoute)
	{
		let tmpBase = pTileRoute.replace(/\/\*+\s*$/, '');
		let tmpSegments = tmpBase.split('/').filter((pSegment) => pSegment.length > 0);
		let tmpLast = tmpSegments.length > 0 ? tmpSegments[tmpSegments.length - 1] : '';
		return tmpLast ? `/${tmpLast}/` : false;
	}

	/**
	 * Recover the tile sub-path (e.g. 'image.dzi' or 'image_files/11/0_0.jpeg')
	 * from the request. Prefers the server's splat param, falls back to the
	 * marker split. Rejects any sub-path containing a traversal segment.
	 */
	_extractTileSubPath(pRouteOptions, pRequest)
	{
		let tmpSubPath = false;

		let tmpParams = pRequest.params || {};
		if (typeof tmpParams['*'] === 'string' && tmpParams['*'].length > 0)
		{
			tmpSubPath = tmpParams['*'];
		}
		else if (typeof tmpParams.star === 'string' && tmpParams.star.length > 0)
		{
			tmpSubPath = tmpParams.star;
		}
		else
		{
			let tmpURL = (typeof pRequest.path === 'function') ? pRequest.path() : (pRequest.url || '');
			tmpURL = tmpURL.split('?')[0];
			let tmpMarker = pRouteOptions._TileMarker;
			if (tmpMarker)
			{
				let tmpIndex = tmpURL.lastIndexOf(tmpMarker);
				if (tmpIndex >= 0)
				{
					tmpSubPath = tmpURL.slice(tmpIndex + tmpMarker.length);
				}
			}
		}

		if (!tmpSubPath)
		{
			return false;
		}

		try { tmpSubPath = decodeURIComponent(tmpSubPath); }
		catch (pError) { return false; }

		tmpSubPath = tmpSubPath.replace(/^\/+/, '');

		// Reject traversal before it reaches the filesystem join.
		if (tmpSubPath.split('/').some((pSegment) => pSegment === '..'))
		{
			return false;
		}

		return tmpSubPath;
	}

	_sendBuffer(pResponse, pStatus, pContentType, pBuffer)
	{
		try
		{
			if (pResponse.headersSent)
			{
				return;
			}
			pResponse.writeHead(pStatus,
				{
					'Content-Type': pContentType,
					'Content-Length': pBuffer.length,
					'Cache-Control': this.options.DefaultCacheControl
				});
			pResponse.end(pBuffer);
		}
		catch (pError)
		{
			try { pResponse.end(); } catch (pEndError) { /* already torn down */ }
		}
	}

	_sendError(pResponse, pStatus, pMessage)
	{
		try
		{
			if (pResponse.headersSent)
			{
				try { pResponse.end(); } catch (pEndError) { /* already torn down */ }
				return;
			}
			let tmpBody = JSON.stringify({ Success: false, Error: pMessage });
			pResponse.writeHead(pStatus,
				{
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(tmpBody)
				});
			pResponse.end(tmpBody);
		}
		catch (pError)
		{
			try { pResponse.end(); } catch (pEndError) { /* already torn down */ }
		}
	}
}

module.exports = OratorFileService;
module.exports.default_configuration = _DefaultConfiguration;

// Re-export the building blocks so hosts can use them directly if they want to
// wire their own routes without the service wrapper.
module.exports.FileRangeServer = libRangeServer;
module.exports.FileDerivativeCache = libDerivativeCache;
module.exports.FileTileService = libTileService;
