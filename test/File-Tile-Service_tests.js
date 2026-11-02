/**
* Unit + integration tests for the Orator File Service DZI tile service.
*
* The Deep-Zoom geometry is pure and always tested. The dzsave/on-the-fly
* integration tests require a working retold-sharp (libvips) binary; when one
* is not resolvable the suite SKIPS LOUDLY (it never silently passes).
*
* @license MIT
*
* @author Steven Velozo <steven@velozo.com>
*/

const Chai = require('chai');
const Expect = Chai.expect;

const libFS = require('node:fs');
const libOS = require('node:os');
const libPath = require('node:path');

const libTileService = require('../source/File-Tile-Service.js');
const libDerivativeCache = require('../source/File-Derivative-Cache.js');

// Resolve a usable sharp for the integration suite. Prefer the module's own
// retold-sharp; fall back to the native copy installed under orator-conversion
// so this box can genuinely verify tile generation. A shipped install gets its
// own binary via `npm install`.
function resolveUsableSharp()
{
	try
	{
		let tmpSharp = require('retold-sharp');
		if (tmpSharp && typeof tmpSharp.checkAvailable === 'function' && tmpSharp.checkAvailable().available)
		{
			return tmpSharp;
		}
	}
	catch (pError) { /* fall through */ }

	try
	{
		let tmpPath = require.resolve('retold-sharp', { paths: [libPath.resolve(__dirname, '..', '..', 'orator-conversion', 'node_modules')] });
		let tmpSharp = require(tmpPath);
		if (tmpSharp && typeof tmpSharp.checkAvailable === 'function' && tmpSharp.checkAvailable().available)
		{
			return tmpSharp;
		}
	}
	catch (pError) { /* fall through */ }

	return false;
}

suite
(
	'Orator File Service -- File-Tile-Service',
	() =>
	{
		suite
		(
			'describePyramid (pure Deep-Zoom geometry)',
			() =>
			{
				test
				(
					'a 2000x1500 image produces the expected level ladder',
					() =>
					{
						let tmpPyramid = libTileService.describePyramid(2000, 1500, 254, 1);
						// maxLevel = ceil(log2(2000)) = 11, so 12 levels (0..11).
						Expect(tmpPyramid.MaxLevel).to.equal(11);
						Expect(tmpPyramid.Levels.length).to.equal(12);

						// Level 0 is 1x1; the top level is full resolution.
						Expect(tmpPyramid.Levels[0].Width).to.equal(1);
						Expect(tmpPyramid.Levels[0].Height).to.equal(1);
						let tmpTop = tmpPyramid.Levels[11];
						Expect(tmpTop.Width).to.equal(2000);
						Expect(tmpTop.Height).to.equal(1500);
						Expect(tmpTop.Scale).to.equal(1);
						Expect(tmpTop.Columns).to.equal(Math.ceil(2000 / 254)); // 8
						Expect(tmpTop.Rows).to.equal(Math.ceil(1500 / 254));    // 6
					}
				);

				test
				(
					'a 1x1 image is a single level',
					() =>
					{
						let tmpPyramid = libTileService.describePyramid(1, 1, 254, 1);
						Expect(tmpPyramid.MaxLevel).to.equal(0);
						Expect(tmpPyramid.Levels.length).to.equal(1);
						Expect(tmpPyramid.Levels[0].Columns).to.equal(1);
						Expect(tmpPyramid.Levels[0].Rows).to.equal(1);
					}
				);
			}
		);

		suite
		(
			'tileRegion (pure, with DZI overlap)',
			() =>
			{
				let _top = false;
				setup
				(
					() =>
					{
						_top = libTileService.describePyramid(2000, 1500, 254, 1).Levels[11];
					}
				);

				test
				(
					'the first tile has no left/top overlap but right/bottom overlap',
					() =>
					{
						let tmpRegion = libTileService.tileRegion(_top, 0, 0, 254, 1);
						Expect(tmpRegion).to.deep.equal({ Left: 0, Top: 0, Width: 255, Height: 255 });
					}
				);

				test
				(
					'the last tile has left/top overlap and is clamped to the image bounds',
					() =>
					{
						let tmpRegion = libTileService.tileRegion(_top, 7, 5, 254, 1);
						Expect(tmpRegion).to.deep.equal({ Left: 1777, Top: 1269, Width: 223, Height: 231 });
					}
				);

				test
				(
					'an out-of-range tile returns false',
					() =>
					{
						Expect(libTileService.tileRegion(_top, 99, 0, 254, 1)).to.equal(false);
					}
				);
			}
		);

		suite
		(
			'dziDescriptorXML (pure)',
			() =>
			{
				test
				(
					'emits a well-formed DZI descriptor with the schema namespace',
					() =>
					{
						let tmpXML = libTileService.dziDescriptorXML(2000, 1500, 254, 1, 'jpeg');
						Expect(tmpXML).to.contain('schemas.microsoft.com/deepzoom/2008');
						Expect(tmpXML).to.contain('TileSize="254"');
						Expect(tmpXML).to.contain('Overlap="1"');
						Expect(tmpXML).to.contain('Width="2000"');
						Expect(tmpXML).to.contain('Height="1500"');
					}
				);
			}
		);

		suite
		(
			'dzsave pre-bake + on-the-fly (integration, needs libvips)',
			() =>
			{
				let _sharp = false;
				let _tmpDir = false;
				let _sourcePath = false;
				let _cache = false;

				suiteSetup
				(
					() =>
					{
						_sharp = resolveUsableSharp();
						if (!_sharp)
						{
							// LOUD skip -- do not pretend tiling was verified.
							console.warn('\n    [tile integration SKIPPED] retold-sharp (libvips) is not resolvable on this host; DZI generation was NOT exercised. Run `npm install` in orator-file-service to enable it.\n');
						}
					}
				);

				setup
				(
					function ()
					{
						if (!_sharp) { return this.skip(); }
						_tmpDir = libFS.mkdtempSync(libPath.join(libOS.tmpdir(), 'ofs-tile-'));
						_sourcePath = libPath.join(_tmpDir, 'big.png');
					}
				);

				teardown
				(
					() =>
					{
						if (_tmpDir)
						{
							try { libFS.rmSync(_tmpDir, { recursive: true, force: true }); }
							catch (pError) { /* best effort */ }
						}
					}
				);

				test
				(
					'ensurePyramid writes a DZI descriptor and a tile pyramid',
					function (fDone)
					{
						this.timeout(20000);
						// Build a real 2000x1500 gradient source with sharp itself.
						_sharp(
							{
								create: { width: 2000, height: 1500, channels: 3, background: { r: 40, g: 90, b: 160 } }
							}).png().toFile(_sourcePath, (pCreateError) =>
							{
								Expect(pCreateError).to.not.be.ok;

								_cache = new libDerivativeCache({ CacheDirectory: libPath.join(_tmpDir, 'cache') });
								let tmpTiler = new libTileService({ Cache: _cache, Sharp: _sharp, TileSize: 254, Overlap: 1, Format: 'jpeg' });
								Expect(tmpTiler.available()).to.equal(true);

								tmpTiler.ensurePyramid(_sourcePath, (pError, pLayout) =>
								{
									Expect(pError).to.not.be.ok;
									Expect(libFS.existsSync(pLayout.DescriptorPath)).to.equal(true);

									let tmpFilesDir = libPath.join(pLayout.DirectoryPath, pLayout.TilesDirName);
									Expect(libFS.existsSync(tmpFilesDir)).to.equal(true);

									// 12 levels (0..11) should be present as sub-directories.
									let tmpLevelDirs = libFS.readdirSync(tmpFilesDir).filter((pName) => (/^\d+$/).test(pName));
									Expect(tmpLevelDirs.length).to.equal(12);

									// The top level should carry the 0_0 tile.
									Expect(libFS.existsSync(libPath.join(tmpFilesDir, '11', '0_0.jpeg'))).to.equal(true);

									// The descriptor should agree with our pure geometry.
									let tmpXML = libFS.readFileSync(pLayout.DescriptorPath, 'utf8');
									Expect(tmpXML).to.contain('Width="2000"');
									Expect(tmpXML).to.contain('Height="1500"');

									return fDone();
								});
							});
					}
				);

				test
				(
					'a second ensurePyramid call is served from cache',
					function (fDone)
					{
						this.timeout(20000);
						_sharp(
							{
								create: { width: 1024, height: 768, channels: 3, background: { r: 10, g: 10, b: 10 } }
							}).png().toFile(_sourcePath, () =>
							{
								_cache = new libDerivativeCache({ CacheDirectory: libPath.join(_tmpDir, 'cache') });
								let tmpTiler = new libTileService({ Cache: _cache, Sharp: _sharp });
								tmpTiler.ensurePyramid(_sourcePath, (pError, pFirst) =>
								{
									Expect(pError).to.not.be.ok;
									Expect(pFirst.Cached).to.equal(false);
									tmpTiler.ensurePyramid(_sourcePath, (pError2, pSecond) =>
									{
										Expect(pError2).to.not.be.ok;
										Expect(pSecond.Cached).to.equal(true);
										Expect(pSecond.Key).to.equal(pFirst.Key);
										return fDone();
									});
								});
							});
					}
				);

				test
				(
					'renderTile (on-the-fly) returns real image bytes for a valid tile',
					function (fDone)
					{
						this.timeout(20000);
						_sharp(
							{
								create: { width: 1200, height: 900, channels: 3, background: { r: 200, g: 50, b: 50 } }
							}).png().toFile(_sourcePath, () =>
							{
								let tmpTiler = new libTileService({ Sharp: _sharp, Format: 'jpeg' });
								// Top level for a 1200x900 image: maxLevel = ceil(log2(1200)) = 11.
								tmpTiler.renderTile(_sourcePath, 11, 0, 0, (pError, pResult) =>
								{
									Expect(pError).to.not.be.ok;
									Expect(pResult.ContentType).to.equal('image/jpeg');
									Expect(pResult.Buffer.length).to.be.greaterThan(0);
									// JPEG magic bytes.
									Expect(pResult.Buffer[0]).to.equal(0xFF);
									Expect(pResult.Buffer[1]).to.equal(0xD8);
									return fDone();
								});
							});
					}
				);
			}
		);
	}
);
