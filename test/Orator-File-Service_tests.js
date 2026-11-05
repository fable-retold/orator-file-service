/**
* Unit tests for the Orator File Service provider wiring.
*
* Uses a real Fable with a fake Orator whose serviceServer captures route
* handlers, so routing + the resolver seam + status codes are exercised with
* no live HTTP server. Tile tests reuse the native sharp installed under
* orator-conversion, and SKIP LOUDLY when it is not resolvable.
*
* @license MIT
*
* @author Steven Velozo <steven@velozo.com>
*/

const Chai = require('chai');
const Expect = Chai.expect;

const libFable = require('fable');
const libFS = require('node:fs');
const libOS = require('node:os');
const libPath = require('node:path');
const libStream = require('node:stream');

const libOratorFileService = require('../source/Orator-File-Service.js');
const libTileService = require('../source/File-Tile-Service.js');

class CollectorResponse extends libStream.Writable
{
	constructor()
	{
		super();
		this.statusCode = false;
		this.headers = false;
		this.headersSent = false;
		this.chunks = [];
	}

	writeHead(pStatus, pHeaders)
	{
		this.statusCode = pStatus;
		this.headers = pHeaders;
		this.headersSent = true;
	}

	_write(pChunk, pEncoding, fDone)
	{
		this.chunks.push(Buffer.from(pChunk));
		return fDone();
	}

	end(pChunk)
	{
		if (pChunk)
		{
			this.chunks.push(Buffer.from(pChunk));
		}
		return super.end();
	}

	get body()
	{
		return Buffer.concat(this.chunks);
	}
}

function makeFakeOrator()
{
	return {
		serviceServer:
		{
			handlers: {},
			get: function (pRoute, fHandler) { this.handlers[pRoute] = fHandler; }
		}
	};
}

function resolveUsableSharp()
{
	try
	{
		let tmpSharp = require('retold-sharp');
		if (tmpSharp && typeof tmpSharp.checkAvailable === 'function' && tmpSharp.checkAvailable().available) { return tmpSharp; }
	}
	catch (pError) { /* fall through */ }
	try
	{
		let tmpPath = require.resolve('retold-sharp', { paths: [libPath.resolve(__dirname, '..', '..', 'orator-conversion', 'node_modules')] });
		let tmpSharp = require(tmpPath);
		if (tmpSharp && typeof tmpSharp.checkAvailable === 'function' && tmpSharp.checkAvailable().available) { return tmpSharp; }
	}
	catch (pError) { /* fall through */ }
	return false;
}

suite
(
	'Orator File Service -- provider wiring',
	() =>
	{
		let _fable = false;
		let _orator = false;
		let _service = false;
		let _tmpDir = false;

		setup
		(
			() =>
			{
				_fable = new libFable();
				_orator = makeFakeOrator();
				_fable.Orator = _orator;
				_tmpDir = libFS.mkdtempSync(libPath.join(libOS.tmpdir(), 'ofs-svc-'));
				_service = new libOratorFileService(_fable, { CacheDirectory: libPath.join(_tmpDir, 'cache') }, 'OratorFileService');
			}
		);

		teardown
		(
			() =>
			{
				try { libFS.rmSync(_tmpDir, { recursive: true, force: true }); }
				catch (pError) { /* best effort */ }
			}
		);

		suite
		(
			'byte serving via the resolver seam',
			() =>
			{
				let _filePath = false;
				const _Payload = Buffer.from('the quick brown fox jumps', 'utf8'); // 25 bytes

				setup
				(
					() =>
					{
						_filePath = libPath.join(_tmpDir, 'doc.txt');
						libFS.writeFileSync(_filePath, _Payload);
					}
				);

				test
				(
					'addFileRoute registers a GET handler',
					() =>
					{
						let tmpOK = _service.addFileRoute(
							{
								Route: '/files/:id',
								Resolver: (pRequest, fCallback) => fCallback(null, { Allowed: true, AbsolutePath: _filePath })
							});
						Expect(tmpOK).to.equal(true);
						Expect(typeof _orator.serviceServer.handlers['/files/:id']).to.equal('function');
					}
				);

				test
				(
					'a resolved file is streamed with a 200',
					(fDone) =>
					{
						_service.addFileRoute(
							{
								Route: '/files/:id',
								Resolver: (pRequest, fCallback) => fCallback(null, { Allowed: true, AbsolutePath: _filePath, MIMEType: 'text/plain' })
							});
						let tmpResponse = new CollectorResponse();
						tmpResponse.on('finish', () =>
						{
							Expect(tmpResponse.statusCode).to.equal(200);
							Expect(tmpResponse.headers['Content-Type']).to.equal('text/plain');
							Expect(tmpResponse.body.toString('utf8')).to.equal(_Payload.toString('utf8'));
							return fDone();
						});
						_orator.serviceServer.handlers['/files/:id']({ method: 'GET', headers: {}, params: { id: '1' } }, tmpResponse, () => {});
					}
				);

				test
				(
					'a Range request is answered with a 206 slice',
					(fDone) =>
					{
						_service.addFileRoute(
							{
								Route: '/files/:id',
								Resolver: (pRequest, fCallback) => fCallback(null, { Allowed: true, AbsolutePath: _filePath })
							});
						let tmpResponse = new CollectorResponse();
						tmpResponse.on('finish', () =>
						{
							Expect(tmpResponse.statusCode).to.equal(206);
							Expect(tmpResponse.body.toString('utf8')).to.equal('quick');
							return fDone();
						});
						_orator.serviceServer.handlers['/files/:id']({ method: 'GET', headers: { range: 'bytes=4-8' }, params: {} }, tmpResponse, () => {});
					}
				);

				test
				(
					'a denied resolution yields 403',
					(fDone) =>
					{
						_service.addFileRoute(
							{
								Route: '/files/:id',
								Resolver: (pRequest, fCallback) => fCallback(null, { Allowed: false })
							});
						let tmpResponse = new CollectorResponse();
						_orator.serviceServer.handlers['/files/:id']({ method: 'GET', headers: {}, params: {} }, tmpResponse, () =>
						{
							Expect(tmpResponse.statusCode).to.equal(403);
							return fDone();
						});
					}
				);

				test
				(
					'a resolution with no path yields 404',
					(fDone) =>
					{
						_service.addFileRoute(
							{
								Route: '/files/:id',
								Resolver: (pRequest, fCallback) => fCallback(null, { Allowed: true })
							});
						let tmpResponse = new CollectorResponse();
						_orator.serviceServer.handlers['/files/:id']({ method: 'GET', headers: {}, params: {} }, tmpResponse, () =>
						{
							Expect(tmpResponse.statusCode).to.equal(404);
							return fDone();
						});
					}
				);

				test
				(
					'a missing file on disk yields 404',
					(fDone) =>
					{
						_service.addFileRoute(
							{
								Route: '/files/:id',
								Resolver: (pRequest, fCallback) => fCallback(null, { Allowed: true, AbsolutePath: libPath.join(_tmpDir, 'ghost.txt') })
							});
						let tmpResponse = new CollectorResponse();
						_orator.serviceServer.handlers['/files/:id']({ method: 'GET', headers: {}, params: {} }, tmpResponse, () =>
						{
							Expect(tmpResponse.statusCode).to.equal(404);
							return fDone();
						});
					}
				);
			}
		);

		suite
		(
			'tile route (needs libvips)',
			() =>
			{
				let _sharp = false;
				let _imagePath = false;

				suiteSetup
				(
					() =>
					{
						_sharp = resolveUsableSharp();
						if (!_sharp)
						{
							console.warn('\n    [tile-route integration SKIPPED] retold-sharp (libvips) not resolvable; the tile route was NOT exercised.\n');
						}
					}
				);

				setup
				(
					function (fDone)
					{
						if (!_sharp) { this.skip(); return fDone(); }
						// Inject the working sharp into the service's tile service.
						_service._tileService = new libTileService({ Cache: _service.cache, Sharp: _sharp, Format: 'jpeg' });
						_imagePath = libPath.join(_tmpDir, 'huge.png');
						_sharp({ create: { width: 1024, height: 768, channels: 3, background: { r: 20, g: 120, b: 90 } } })
							.png().toFile(_imagePath, () => fDone());
					}
				);

				test
				(
					'reports tiles available',
					function ()
					{
						Expect(_service.tilesAvailable()).to.equal(true);
					}
				);

				test
				(
					'the DZI descriptor is served (pre-bake)',
					function (fDone)
					{
						this.timeout(20000);
						_service.addFileRoute(
							{
								Route: '/img/:id',
								EnableTiles: true,
								TileRoute: '/img/:id/Tiles/*',
								Resolver: (pRequest, fCallback) => fCallback(null, { Allowed: true, AbsolutePath: _imagePath })
							});
						let tmpResponse = new CollectorResponse();
						let fnDone = () =>
						{
							Expect(tmpResponse.statusCode).to.equal(200);
							Expect(tmpResponse.body.toString('utf8')).to.contain('Width="1024"');
							return fDone();
						};
						tmpResponse.on('finish', fnDone);
						_orator.serviceServer.handlers['/img/:id/Tiles/*'](
							{ method: 'GET', headers: {}, params: { id: '1', '*': 'image.dzi' } }, tmpResponse, () => {});
					}
				);

				test
				(
					'a specific tile is served as image bytes (pre-bake)',
					function (fDone)
					{
						this.timeout(20000);
						_service.addFileRoute(
							{
								Route: '/img/:id',
								EnableTiles: true,
								TileRoute: '/img/:id/Tiles/*',
								Resolver: (pRequest, fCallback) => fCallback(null, { Allowed: true, AbsolutePath: _imagePath })
							});
						let tmpResponse = new CollectorResponse();
						tmpResponse.on('finish', () =>
						{
							Expect(tmpResponse.statusCode).to.equal(200);
							Expect(tmpResponse.headers['Content-Type']).to.equal('image/jpeg');
							Expect(tmpResponse.body[0]).to.equal(0xFF);
							Expect(tmpResponse.body[1]).to.equal(0xD8);
							return fDone();
						});
						// 1024x768 -> maxLevel = ceil(log2(1024)) = 10 (full resolution).
						_orator.serviceServer.handlers['/img/:id/Tiles/*'](
							{ method: 'GET', headers: {}, params: { id: '1', '*': 'image_files/10/0_0.jpeg' } }, tmpResponse, () => {});
					}
				);

				test
				(
					'a path-traversal tile request is rejected',
					function (fDone)
					{
						_service.addFileRoute(
							{
								Route: '/img/:id',
								EnableTiles: true,
								TileRoute: '/img/:id/Tiles/*',
								Resolver: (pRequest, fCallback) => fCallback(null, { Allowed: true, AbsolutePath: _imagePath })
							});
						let tmpResponse = new CollectorResponse();
						_orator.serviceServer.handlers['/img/:id/Tiles/*'](
							{ method: 'GET', headers: {}, params: { id: '1', '*': '../../../../etc/passwd' } }, tmpResponse, () =>
							{
								Expect(tmpResponse.statusCode).to.equal(404);
								return fDone();
							});
					}
				);
					test
					(
						'addTileRoute registers ONLY the tile route (no bytes route) and serves the descriptor',
						function (fDone)
						{
							this.timeout(20000);
							let tmpOK = _service.addTileRoute(
								{
									TileRoute: '/tilesonly/:id/Tiles/*',
									Resolver: (pRequest, fCallback) => fCallback(null, { Allowed: true, AbsolutePath: _imagePath })
								});
							Expect(tmpOK).to.equal(true);
							// The tile route is wired...
							Expect(typeof _orator.serviceServer.handlers['/tilesonly/:id/Tiles/*']).to.equal('function');
							// ...and no bytes route was registered alongside it.
							Expect(_orator.serviceServer.handlers['/tilesonly/:id']).to.equal(undefined);
							let tmpResponse = new CollectorResponse();
							tmpResponse.on('finish', () =>
							{
								Expect(tmpResponse.statusCode).to.equal(200);
								Expect(tmpResponse.body.toString('utf8')).to.contain('Width="1024"');
								return fDone();
							});
							_orator.serviceServer.handlers['/tilesonly/:id/Tiles/*'](
								{ method: 'GET', headers: {}, params: { id: '1', '*': 'image.dzi' } }, tmpResponse, () => {});
						}
					);

			}
		);

		suite
		(
			'tile route when tiling is unavailable',
			() =>
			{
				test
				(
					'responds 501 when retold-sharp is absent',
					(fDone) =>
					{
						// Force an unavailable tile service: inject a retold-sharp stub that reports itself unavailable, so the
						// 501 gate is exercised deterministically. (Passing { Sharp: false } is NOT enough -- a falsy Sharp makes
						// the constructor fall back to require('retold-sharp'), which succeeds on any machine where libvips IS
						// installed, and the gate would never be reached.)
						_service._tileService = new libTileService({ Sharp: { checkAvailable: () => ({ available: false }) } });
						Expect(_service.tilesAvailable()).to.equal(false);
						_service.addFileRoute(
							{
								Route: '/img/:id',
								EnableTiles: true,
								TileRoute: '/img/:id/Tiles/*',
								Resolver: (pRequest, fCallback) => fCallback(null, { Allowed: true, AbsolutePath: '/does/not/matter' })
							});
						let tmpResponse = new CollectorResponse();
						_orator.serviceServer.handlers['/img/:id/Tiles/*'](
							{ method: 'GET', headers: {}, params: { id: '1', '*': 'image.dzi' } }, tmpResponse, () =>
							{
								Expect(tmpResponse.statusCode).to.equal(501);
								return fDone();
							});
					}
				);
			}
		);
	}
);
