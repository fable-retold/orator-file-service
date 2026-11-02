/**
* Orator File Service -- deep-zoom (DZI) tile service
*
* Turns an arbitrarily large raster image into a Deep Zoom Image (DZI) tile
* pyramid that OpenSeaDragon (and pict-section-openseadragon) consume natively.
*
* The generator is libvips' `dzsave`, reached through `retold-sharp`'s
* `.tile({ layout: 'dzi' })`. libvips is the most performant option available:
* it streams the pyramid in a single pass with bounded memory -- it does NOT
* decode the whole gigapixel image into RAM, which is the entire point for
* 800 MB / giga-pixel inputs. `limitInputPixels: false` lifts sharp's pixel
* guard so genuinely enormous sources are allowed.
*
* Two strategies, selectable per call (the module-level default is pre-bake):
*   - PRE-BAKE  (default): dzsave the full pyramid once into the derivative
*                cache, then let the host serve the tiles as ordinary static
*                files (bytes, ranges, HTTP caching all free). Fastest repeat
*                access, simplest wiring.
*   - ON-THE-FLY (fallback): crop+resize a single tile per request. No pyramid
*                storage; higher per-tile cost. Use when the pyramid cannot be
*                persisted, or the source is already pyramidal/random-access.
*
* retold-sharp is capability-gated: when the native binary is absent,
* `available()` is false and the tiler abstains rather than throwing, so a host
* without an image toolchain simply never offers deep zoom.
*
* The Deep-Zoom geometry (`describePyramid`, `tileRegion`, `dziDescriptorXML`)
* is pure and unit-tested with no sharp involved.
*
* @license MIT
*
* @author Steven Velozo <steven@velozo.com>
*/

const libPath = require('node:path');

const DEFAULT_TILE_SIZE = 254;   // DZI convention; OpenSeaDragon's default expectation
const DEFAULT_OVERLAP = 1;       // 1px overlap on interior tile edges
const DEFAULT_FORMAT = 'jpeg';   // photographic default; use 'png'/'webp' when alpha matters

/**
 * Describe the DZI pyramid for an image of a given size. Pure.
 *
 * Deep Zoom numbers levels 0..maxLevel, where level maxLevel is full
 * resolution and each lower level halves the dimensions (level 0 is 1x1).
 *
 * @param {number} pWidth
 * @param {number} pHeight
 * @param {number} [pTileSize=254]
 * @param {number} [pOverlap=1]
 * @returns {Object} { Width, Height, TileSize, Overlap, MaxLevel, Levels: [{ Level, Width, Height, Columns, Rows, Scale }] }
 */
function describePyramid(pWidth, pHeight, pTileSize, pOverlap)
{
	let tmpTileSize = pTileSize || DEFAULT_TILE_SIZE;
	let tmpOverlap = (typeof pOverlap === 'number') ? pOverlap : DEFAULT_OVERLAP;
	let tmpWidth = Math.max(1, Math.floor(pWidth || 1));
	let tmpHeight = Math.max(1, Math.floor(pHeight || 1));

	let tmpMaxDimension = Math.max(tmpWidth, tmpHeight);
	let tmpMaxLevel = Math.ceil(Math.log2(tmpMaxDimension));
	if (!(tmpMaxLevel >= 0))
	{
		tmpMaxLevel = 0;
	}

	let tmpLevels = [];
	for (let tmpLevel = 0; tmpLevel <= tmpMaxLevel; tmpLevel++)
	{
		let tmpScale = Math.pow(2, tmpMaxLevel - tmpLevel);
		let tmpLevelWidth = Math.max(1, Math.ceil(tmpWidth / tmpScale));
		let tmpLevelHeight = Math.max(1, Math.ceil(tmpHeight / tmpScale));
		tmpLevels.push(
			{
				Level: tmpLevel,
				Width: tmpLevelWidth,
				Height: tmpLevelHeight,
				Columns: Math.max(1, Math.ceil(tmpLevelWidth / tmpTileSize)),
				Rows: Math.max(1, Math.ceil(tmpLevelHeight / tmpTileSize)),
				Scale: tmpScale
			});
	}

	return {
		Width: tmpWidth,
		Height: tmpHeight,
		TileSize: tmpTileSize,
		Overlap: tmpOverlap,
		MaxLevel: tmpMaxLevel,
		Levels: tmpLevels
	};
}

/**
 * The pixel region (in a level's own coordinate space) covered by one tile,
 * including the DZI edge overlap. Pure. Used by the on-the-fly path.
 *
 * @param {Object} pLevel - A level entry from describePyramid().Levels.
 * @param {number} pColumn - Zero-based tile column.
 * @param {number} pRow - Zero-based tile row.
 * @param {number} pTileSize
 * @param {number} pOverlap
 * @returns {Object|boolean} { Left, Top, Width, Height } or false if out of range.
 */
function tileRegion(pLevel, pColumn, pRow, pTileSize, pOverlap)
{
	if (!pLevel || pColumn < 0 || pRow < 0 || pColumn >= pLevel.Columns || pRow >= pLevel.Rows)
	{
		return false;
	}

	let tmpOverlapLeft = (pColumn === 0) ? 0 : pOverlap;
	let tmpOverlapTop = (pRow === 0) ? 0 : pOverlap;
	let tmpOverlapRight = (pColumn === pLevel.Columns - 1) ? 0 : pOverlap;
	let tmpOverlapBottom = (pRow === pLevel.Rows - 1) ? 0 : pOverlap;

	let tmpLeft = (pColumn * pTileSize) - tmpOverlapLeft;
	let tmpTop = (pRow * pTileSize) - tmpOverlapTop;
	let tmpWidth = pTileSize + tmpOverlapLeft + tmpOverlapRight;
	let tmpHeight = pTileSize + tmpOverlapTop + tmpOverlapBottom;

	// Clamp to the level bounds (the last tile is usually short).
	if (tmpLeft + tmpWidth > pLevel.Width)
	{
		tmpWidth = pLevel.Width - tmpLeft;
	}
	if (tmpTop + tmpHeight > pLevel.Height)
	{
		tmpHeight = pLevel.Height - tmpTop;
	}

	return { Left: tmpLeft, Top: tmpTop, Width: tmpWidth, Height: tmpHeight };
}

/**
 * The DZI descriptor XML for an image. Pure. (sharp writes its own for the
 * pre-bake path; this is for the on-the-fly path, which must serve a descriptor
 * for a pyramid that is never materialized.)
 *
 * @param {number} pWidth
 * @param {number} pHeight
 * @param {number} pTileSize
 * @param {number} pOverlap
 * @param {string} pFormat
 * @returns {string}
 */
function dziDescriptorXML(pWidth, pHeight, pTileSize, pOverlap, pFormat)
{
	return '<?xml version="1.0" encoding="UTF-8"?>\n'
		+ '<Image xmlns="http://schemas.microsoft.com/deepzoom/2008"'
		+ ` TileSize="${pTileSize}" Overlap="${pOverlap}" Format="${pFormat}">\n`
		+ `  <Size Width="${pWidth}" Height="${pHeight}"/>\n`
		+ '</Image>\n';
}

class FileTileService
{
	/**
	 * @param {Object} [pOptions]
	 * @param {Object} pOptions.Cache - A FileDerivativeCache instance (required for pre-bake).
	 * @param {Object} [pOptions.Sharp] - Injectable retold-sharp module (default require('retold-sharp')).
	 * @param {number} [pOptions.TileSize=254]
	 * @param {number} [pOptions.Overlap=1]
	 * @param {string} [pOptions.Format='jpeg']
	 * @param {number} [pOptions.Quality=80] - JPEG/WebP quality.
	 * @param {Object} [pOptions.FS] - Injectable fs module (default node:fs).
	 * @param {Object} [pOptions.Log] - Optional logger with .warn/.info/.error.
	 */
	constructor(pOptions)
	{
		let tmpOptions = pOptions || {};
		this.cache = tmpOptions.Cache || false;
		this.tileSize = tmpOptions.TileSize || DEFAULT_TILE_SIZE;
		this.overlap = (typeof tmpOptions.Overlap === 'number') ? tmpOptions.Overlap : DEFAULT_OVERLAP;
		this.format = tmpOptions.Format || DEFAULT_FORMAT;
		this.quality = tmpOptions.Quality || 80;
		this.libFS = tmpOptions.FS || require('node:fs');
		this.log = tmpOptions.Log || false;

		this._sharp = tmpOptions.Sharp || false;
		if (!this._sharp)
		{
			try { this._sharp = require('retold-sharp'); }
			catch (pError) { this._sharp = false; }
		}
	}

	/**
	 * @returns {boolean} true when the sharp native/WASM binding is usable.
	 */
	available()
	{
		if (!this._sharp || typeof this._sharp.checkAvailable !== 'function')
		{
			return false;
		}
		try { return this._sharp.checkAvailable().available === true; }
		catch (pError) { return false; }
	}

	/**
	 * The variant string that distinguishes this tiler's output in the cache.
	 * @returns {string}
	 */
	variantString()
	{
		return `dzi-${this.tileSize}-${this.overlap}-${this.format}`;
	}

	/**
	 * Pre-bake (or reuse a cached) DZI pyramid for a source image. On success
	 * the callback receives the on-disk layout so the host can static-serve it:
	 *   { Key, DirectoryPath, DescriptorPath, DescriptorName, TilesDirName, Cached }
	 * `DescriptorName` ('image.dzi') + `TilesDirName` ('image_files') are the
	 * names dzsave produces under DirectoryPath.
	 *
	 * @param {string} pSourcePath - Absolute path to the source image.
	 * @param {function} fCallback - Callback(error, layout).
	 * @returns {void}
	 */
	ensurePyramid(pSourcePath, fCallback)
	{
		if (!this.available())
		{
			return fCallback(new Error('Tile service unavailable: retold-sharp (libvips) is not installed.'));
		}
		if (!this.cache)
		{
			return fCallback(new Error('Tile service pre-bake requires a derivative cache.'));
		}

		let tmpStat;
		try { tmpStat = this.libFS.statSync(pSourcePath); }
		catch (pError) { return fCallback(pError); }

		let tmpKey = this.cache.keyFor(pSourcePath, tmpStat.mtimeMs, this.variantString());
		let tmpLayout =
			{
				Key: tmpKey,
				DirectoryPath: this.cache.directoryPathFor(tmpKey),
				DescriptorName: 'image.dzi',
				TilesDirName: 'image_files',
				DescriptorPath: libPath.join(this.cache.directoryPathFor(tmpKey), 'image.dzi'),
				Cached: false
			};

		// Cache hit -- reuse the ready pyramid.
		if (this.cache.hasReadyDirectory(tmpKey))
		{
			tmpLayout.Cached = true;
			return fCallback(null, tmpLayout);
		}

		let tmpDirectory = this.cache.prepareDirectory(tmpKey);
		// sharp appends '.dzi' and '_files' to the basename it is handed, so we
		// pass the bare stem 'image' to get 'image.dzi' + 'image_files/'.
		let tmpBasePath = libPath.join(tmpDirectory, 'image');

		let tmpSharpInstance;
		try
		{
			tmpSharpInstance = this._sharp(pSourcePath, { limitInputPixels: false });
			// Apply the tile image format before invoking the dzsave writer.
			if (this.format === 'png')
			{
				tmpSharpInstance = tmpSharpInstance.png();
			}
			else if (this.format === 'webp')
			{
				tmpSharpInstance = tmpSharpInstance.webp({ quality: this.quality });
			}
			else
			{
				tmpSharpInstance = tmpSharpInstance.jpeg({ quality: this.quality });
			}
			// sharp/libvips names the Deep Zoom layout 'dz' (it writes a <name>.dzi
			// descriptor and a <name>_files/ tile pyramid).
			tmpSharpInstance = tmpSharpInstance.tile({ size: this.tileSize, overlap: this.overlap, layout: 'dz' });
		}
		catch (pError)
		{
			return fCallback(pError);
		}

		tmpSharpInstance.toFile(tmpBasePath, (pError) =>
		{
			if (pError)
			{
				if (this.log) { this.log.error(`DZI generation failed for ${pSourcePath}: ${pError.message}`); }
				return fCallback(pError);
			}
			try { this.cache.markDirectoryReady(tmpKey); }
			catch (pMarkError) { return fCallback(pMarkError); }
			return fCallback(null, tmpLayout);
		});
	}

	/**
	 * Read just the dimensions of a source image (bounded work, no full decode).
	 *
	 * @param {string} pSourcePath
	 * @param {function} fCallback - Callback(error, { Width, Height }).
	 * @returns {void}
	 */
	probeDimensions(pSourcePath, fCallback)
	{
		if (!this.available())
		{
			return fCallback(new Error('Tile service unavailable: retold-sharp (libvips) is not installed.'));
		}
		this._sharp(pSourcePath, { limitInputPixels: false }).metadata((pError, pMetadata) =>
		{
			if (pError) { return fCallback(pError); }
			return fCallback(null, { Width: pMetadata.width, Height: pMetadata.height });
		});
	}

	/**
	 * On-the-fly fallback: render one DZI tile to a buffer. Computes the tile's
	 * region in the full-resolution source, extracts it, and resizes to the
	 * level's scale. Higher per-request cost than the pre-baked pyramid; use
	 * when the pyramid cannot be persisted.
	 *
	 * @param {string} pSourcePath
	 * @param {number} pLevel
	 * @param {number} pColumn
	 * @param {number} pRow
	 * @param {function} fCallback - Callback(error, { Buffer, ContentType }).
	 * @returns {void}
	 */
	renderTile(pSourcePath, pLevel, pColumn, pRow, fCallback)
	{
		if (!this.available())
		{
			return fCallback(new Error('Tile service unavailable: retold-sharp (libvips) is not installed.'));
		}

		this.probeDimensions(pSourcePath, (pError, pDimensions) =>
		{
			if (pError) { return fCallback(pError); }

			let tmpPyramid = describePyramid(pDimensions.Width, pDimensions.Height, this.tileSize, this.overlap);
			let tmpLevel = tmpPyramid.Levels[pLevel];
			if (!tmpLevel)
			{
				return fCallback(new Error(`DZI level out of range: ${pLevel}`));
			}

			let tmpRegion = tileRegion(tmpLevel, pColumn, pRow, this.tileSize, this.overlap);
			if (!tmpRegion)
			{
				return fCallback(new Error(`DZI tile out of range: ${pLevel}/${pColumn}_${pRow}`));
			}

			// Map the level-space region back to full-resolution source pixels.
			let tmpScale = tmpLevel.Scale;
			let tmpSourceLeft = Math.floor(tmpRegion.Left * tmpScale);
			let tmpSourceTop = Math.floor(tmpRegion.Top * tmpScale);
			let tmpSourceWidth = Math.min(Math.ceil(tmpRegion.Width * tmpScale), pDimensions.Width - tmpSourceLeft);
			let tmpSourceHeight = Math.min(Math.ceil(tmpRegion.Height * tmpScale), pDimensions.Height - tmpSourceTop);

			let tmpContentType = `image/${this.format === 'jpeg' ? 'jpeg' : this.format}`;

			let tmpInstance;
			try
			{
				tmpInstance = this._sharp(pSourcePath, { limitInputPixels: false })
					.extract({ left: tmpSourceLeft, top: tmpSourceTop, width: tmpSourceWidth, height: tmpSourceHeight });

				// Only downscale -- level maxLevel (scale 1) needs no resize.
				if (tmpScale > 1)
				{
					tmpInstance = tmpInstance.resize(tmpRegion.Width, tmpRegion.Height);
				}

				if (this.format === 'png')
				{
					tmpInstance = tmpInstance.png();
				}
				else if (this.format === 'webp')
				{
					tmpInstance = tmpInstance.webp({ quality: this.quality });
				}
				else
				{
					tmpInstance = tmpInstance.jpeg({ quality: this.quality });
				}
			}
			catch (pExtractError)
			{
				return fCallback(pExtractError);
			}

			tmpInstance.toBuffer((pBufferError, pBuffer) =>
			{
				if (pBufferError) { return fCallback(pBufferError); }
				return fCallback(null, { Buffer: pBuffer, ContentType: tmpContentType });
			});
		});
	}
}

module.exports = FileTileService;
module.exports.describePyramid = describePyramid;
module.exports.tileRegion = tileRegion;
module.exports.dziDescriptorXML = dziDescriptorXML;
module.exports.DEFAULT_TILE_SIZE = DEFAULT_TILE_SIZE;
module.exports.DEFAULT_OVERLAP = DEFAULT_OVERLAP;
module.exports.DEFAULT_FORMAT = DEFAULT_FORMAT;
