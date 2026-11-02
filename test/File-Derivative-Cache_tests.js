/**
* Unit tests for the Orator File Service derivative cache.
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

const libDerivativeCache = require('../source/File-Derivative-Cache.js');

suite
(
	'Orator File Service -- File-Derivative-Cache',
	() =>
	{
		let _tmpDir = false;
		let _cache = false;

		setup
		(
			() =>
			{
				_tmpDir = libFS.mkdtempSync(libPath.join(libOS.tmpdir(), 'ofs-cache-'));
				_cache = new libDerivativeCache({ CacheDirectory: _tmpDir });
			}
		);

		teardown
		(
			() =>
			{
				try { libFS.rmSync(_tmpDir, { recursive: true, force: true }); }
				catch (pError) { /* best-effort */ }
			}
		);

		test
		(
			'the same (path, mtime, variant) produces the same key',
			() =>
			{
				let tmpA = _cache.keyFor('/x/y.jpg', 1000, 'thumb-256');
				let tmpB = _cache.keyFor('/x/y.jpg', 1000, 'thumb-256');
				Expect(tmpA).to.equal(tmpB);
			}
		);

		test
		(
			'a different mtime changes the key (source changed on disk)',
			() =>
			{
				let tmpOld = _cache.keyFor('/x/y.jpg', 1000, 'thumb-256');
				let tmpNew = _cache.keyFor('/x/y.jpg', 2000, 'thumb-256');
				Expect(tmpOld).to.not.equal(tmpNew);
			}
		);

		test
		(
			'a different variant changes the key (different derivative)',
			() =>
			{
				let tmpThumb = _cache.keyFor('/x/y.jpg', 1000, 'thumb-256');
				let tmpTile = _cache.keyFor('/x/y.jpg', 1000, 'dzi-254-1-jpeg');
				Expect(tmpThumb).to.not.equal(tmpTile);
			}
		);

		test
		(
			'putFile/getFile round-trips a single-file derivative',
			() =>
			{
				let tmpKey = _cache.keyFor('/x/y.jpg', 1000, 'thumb-256');
				Expect(_cache.hasFile(tmpKey, 'webp')).to.equal(false);
				Expect(_cache.getFile(tmpKey, 'webp')).to.equal(false);

				let tmpPath = _cache.putFile(tmpKey, 'webp', Buffer.from('fake-webp-bytes'));
				Expect(_cache.hasFile(tmpKey, 'webp')).to.equal(true);
				Expect(_cache.getFile(tmpKey, 'webp')).to.equal(tmpPath);
				Expect(libFS.readFileSync(tmpPath).toString()).to.equal('fake-webp-bytes');
			}
		);

		test
		(
			'keys shard into a two-character sub-directory',
			() =>
			{
				let tmpKey = _cache.keyFor('/x/y.jpg', 1000, 'thumb-256');
				let tmpPath = _cache.filePathFor(tmpKey, 'webp');
				Expect(tmpPath).to.contain(libPath.join(_tmpDir, tmpKey.slice(0, 2)));
			}
		);

		test
		(
			'a directory derivative is not "ready" until marked',
			() =>
			{
				let tmpKey = _cache.keyFor('/x/huge.tif', 5000, 'dzi-254-1-jpeg');
				Expect(_cache.hasReadyDirectory(tmpKey)).to.equal(false);

				let tmpDir = _cache.prepareDirectory(tmpKey);
				// Write some tiles into it...
				libFS.writeFileSync(libPath.join(tmpDir, 'image.dzi'), '<Image/>');
				// ...still not ready, because generation might have crashed here.
				Expect(_cache.hasReadyDirectory(tmpKey)).to.equal(false);

				_cache.markDirectoryReady(tmpKey);
				Expect(_cache.hasReadyDirectory(tmpKey)).to.equal(true);
			}
		);

		test
		(
			'prepareDirectory clears stale contents from a prior partial run',
			() =>
			{
				let tmpKey = _cache.keyFor('/x/huge.tif', 5000, 'dzi-254-1-jpeg');
				let tmpDir = _cache.prepareDirectory(tmpKey);
				libFS.writeFileSync(libPath.join(tmpDir, 'stale.txt'), 'leftover');
				Expect(libFS.existsSync(libPath.join(tmpDir, 'stale.txt'))).to.equal(true);

				// Re-preparing wipes the previous partial output.
				let tmpDir2 = _cache.prepareDirectory(tmpKey);
				Expect(tmpDir2).to.equal(tmpDir);
				Expect(libFS.existsSync(libPath.join(tmpDir, 'stale.txt'))).to.equal(false);
			}
		);
	}
);
