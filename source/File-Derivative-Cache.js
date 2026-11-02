/**
* Orator File Service -- derivative cache
*
* A content-addressed, mtime-keyed cache for derived artifacts (thumbnails,
* sub-region crops, deep-zoom tile pyramids). The cache key folds the source
* path, its modification time, and a variant descriptor together, so a derived
* artifact is reused until its source file changes on disk and is never
* confused with a different variant.
*
* Single-file derivatives (a thumbnail) live at a sharded path; directory
* derivatives (a DZI pyramid) live under a sharded directory guarded by a
* `.ready` marker the producer writes only once generation has fully
* succeeded -- so a crashed/partial generation is never mistaken for a hit.
*
* Pure filesystem; no sharp, no HTTP. Fully unit-testable.
*
* @license MIT
*
* @author Steven Velozo <steven@velozo.com>
*/

const libFS = require('node:fs');
const libPath = require('node:path');
const libCrypto = require('node:crypto');

const READY_MARKER = '.ready';

class FileDerivativeCache
{
	/**
	 * @param {Object} pOptions
	 * @param {string} pOptions.CacheDirectory - Root directory for cached artifacts.
	 * @param {Object} [pOptions.FS] - Injectable fs module (default node:fs).
	 */
	constructor(pOptions)
	{
		let tmpOptions = pOptions || {};
		this.cacheDirectory = tmpOptions.CacheDirectory || libPath.join(require('node:os').tmpdir(), 'orator-file-service-cache');
		this.libFS = tmpOptions.FS || libFS;
	}

	/**
	 * Derive a stable cache key from the source path, its mtime, and a variant.
	 *
	 * @param {string} pSourcePath - Absolute path of the source file.
	 * @param {number} pMtimeMs - Source modification time in milliseconds.
	 * @param {string} pVariant - A string describing the derivative (e.g. 'thumb-256x256-webp' or 'dzi-254-1-jpeg').
	 * @returns {string} A hex key.
	 */
	keyFor(pSourcePath, pMtimeMs, pVariant)
	{
		let tmpMtime = (typeof pMtimeMs === 'number') ? Math.floor(pMtimeMs) : 0;
		let tmpSeed = `${pSourcePath}|${tmpMtime}|${pVariant || ''}`;
		return libCrypto.createHash('md5').update(tmpSeed).digest('hex');
	}

	/**
	 * The sharded directory that holds artifacts for a key (two-char fan-out
	 * keeps any single directory from growing unbounded).
	 *
	 * @param {string} pKey
	 * @returns {string} Absolute directory path.
	 */
	shardDirectoryFor(pKey)
	{
		return libPath.join(this.cacheDirectory, pKey.slice(0, 2));
	}

	/**
	 * Absolute path of a single-file derivative.
	 *
	 * @param {string} pKey
	 * @param {string} pExtension - Without the leading dot (e.g. 'webp').
	 * @returns {string}
	 */
	filePathFor(pKey, pExtension)
	{
		let tmpExt = (pExtension || 'bin').replace(/^\./, '');
		return libPath.join(this.shardDirectoryFor(pKey), `${pKey}.${tmpExt}`);
	}

	/**
	 * Absolute path of a directory derivative (e.g. a DZI pyramid root).
	 *
	 * @param {string} pKey
	 * @returns {string}
	 */
	directoryPathFor(pKey)
	{
		return libPath.join(this.shardDirectoryFor(pKey), pKey);
	}

	/**
	 * Ensure a directory exists (recursive mkdir, idempotent).
	 *
	 * @param {string} pDirectory
	 * @returns {void}
	 */
	ensureDirectory(pDirectory)
	{
		this.libFS.mkdirSync(pDirectory, { recursive: true });
	}

	/**
	 * @param {string} pKey
	 * @param {string} pExtension
	 * @returns {boolean} true if the single-file derivative exists.
	 */
	hasFile(pKey, pExtension)
	{
		return this.libFS.existsSync(this.filePathFor(pKey, pExtension));
	}

	/**
	 * Write a single-file derivative, creating the shard directory as needed.
	 *
	 * @param {string} pKey
	 * @param {string} pExtension
	 * @param {Buffer} pBuffer
	 * @returns {string} The path the artifact was written to.
	 */
	putFile(pKey, pExtension, pBuffer)
	{
		this.ensureDirectory(this.shardDirectoryFor(pKey));
		let tmpPath = this.filePathFor(pKey, pExtension);
		this.libFS.writeFileSync(tmpPath, pBuffer);
		return tmpPath;
	}

	/**
	 * @param {string} pKey
	 * @param {string} pExtension
	 * @returns {string|boolean} The artifact path, or false on a miss.
	 */
	getFile(pKey, pExtension)
	{
		return this.hasFile(pKey, pExtension) ? this.filePathFor(pKey, pExtension) : false;
	}

	/**
	 * @param {string} pKey
	 * @returns {boolean} true only if a directory derivative is present AND the
	 *   producer wrote its `.ready` marker (i.e. generation finished cleanly).
	 */
	hasReadyDirectory(pKey)
	{
		let tmpMarker = libPath.join(this.directoryPathFor(pKey), READY_MARKER);
		return this.libFS.existsSync(tmpMarker);
	}

	/**
	 * Create (and clear any stale contents of) a directory derivative, returning
	 * its path. The directory is NOT marked ready -- the producer calls
	 * markDirectoryReady() once generation has fully succeeded.
	 *
	 * @param {string} pKey
	 * @returns {string} The (empty, unmarked) directory path.
	 */
	prepareDirectory(pKey)
	{
		let tmpDirectory = this.directoryPathFor(pKey);
		try { this.libFS.rmSync(tmpDirectory, { recursive: true, force: true }); }
		catch (pError) { /* nothing to clear */ }
		this.ensureDirectory(tmpDirectory);
		return tmpDirectory;
	}

	/**
	 * Mark a directory derivative as complete.
	 *
	 * @param {string} pKey
	 * @returns {void}
	 */
	markDirectoryReady(pKey)
	{
		let tmpMarker = libPath.join(this.directoryPathFor(pKey), READY_MARKER);
		this.libFS.writeFileSync(tmpMarker, new Date().toISOString());
	}
}

module.exports = FileDerivativeCache;
module.exports.READY_MARKER = READY_MARKER;
