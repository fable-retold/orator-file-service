/**
* Orator File Service -- HTTP Range byte server
*
* The single most-reused primitive: serve the bytes of a file on disk over
* HTTP/1.1, honoring the `Range` request header (RFC 7233) so that media
* players, PDF viewers, and deep-zoom tilers can seek without downloading the
* whole file. This is the exact Range/206 contract pict-section-fileview
* already speaks.
*
* The range arithmetic lives in the pure `planByteRange()` function so it can
* be unit-tested exhaustively with no filesystem or HTTP involved. `serveFile()`
* layers the IO (stat + stream) on top.
*
* @license MIT
*
* @author Steven Velozo <steven@velozo.com>
*/

const libFS = require('node:fs');
const libPath = require('node:path');

const DEFAULT_MIME_TYPE = 'application/octet-stream';

// mime is a soft dependency -- when present we use it for Content-Type
// detection, otherwise the caller must pass an explicit MIMEType.
let _libMime = false;
let _mimeGetType = false;
try
{
	_libMime = require('mime');
	if (_libMime && typeof _libMime.getType === 'function')
	{
		_mimeGetType = (pName) => _libMime.getType(pName);
	}
	else if (_libMime && _libMime.default && typeof _libMime.default.getType === 'function')
	{
		// mime v4 ships as ESM; require() yields a namespace with .default
		_mimeGetType = (pName) => _libMime.default.getType(pName);
	}
	else if (_libMime && typeof _libMime.lookup === 'function')
	{
		// mime v1 legacy
		_mimeGetType = (pName) => _libMime.lookup(pName);
	}
}
catch (pError)
{
	_libMime = false;
}

/**
 * Resolve a Content-Type for a file name, falling back to octet-stream.
 *
 * @param {string} pFileName - A file name or path.
 * @returns {string} A MIME type string.
 */
function detectMIMEType(pFileName)
{
	if (_mimeGetType && typeof pFileName === 'string')
	{
		let tmpType = _mimeGetType(pFileName);
		if (tmpType)
		{
			return tmpType;
		}
	}
	return DEFAULT_MIME_TYPE;
}

/**
 * Compute the byte plan for a (possibly ranged) request against a file of a
 * known size. Pure -- no IO. Supports a single `bytes=start-end` range,
 * open-ended ranges (`bytes=500-`), and suffix ranges (`bytes=-500`).
 * Multi-range and non-`bytes` units are deliberately ignored (the server MAY
 * answer the whole representation per RFC 7233 §3.1), which keeps one code
 * path for the common single-range case.
 *
 * @param {number} pSize - Total size of the file in bytes.
 * @param {string} [pRangeHeader] - The raw value of the Range request header.
 * @returns {Object} A plan:
 *   { Satisfiable, Partial, Status, Start, End, Length, ContentRange }
 *   For a 416 the plan is { Satisfiable:false, Status:416, ContentRange }.
 */
function planByteRange(pSize, pRangeHeader)
{
	let tmpSize = (typeof pSize === 'number' && pSize >= 0) ? Math.floor(pSize) : 0;

	let fnFull = () =>
	(
		{
			Satisfiable: true,
			Partial: false,
			Status: 200,
			Start: 0,
			End: (tmpSize > 0) ? tmpSize - 1 : 0,
			Length: tmpSize,
			ContentRange: false
		}
	);

	if (!pRangeHeader || typeof pRangeHeader !== 'string')
	{
		return fnFull();
	}

	// Only a single `bytes=` range is honored. Anything else -> serve full.
	let tmpMatch = (/^\s*bytes=(\d*)-(\d*)\s*$/).exec(pRangeHeader);
	if (!tmpMatch)
	{
		return fnFull();
	}

	let tmpStartRaw = tmpMatch[1];
	let tmpEndRaw = tmpMatch[2];

	let fnUnsatisfiable = () =>
	(
		{
			Satisfiable: false,
			Partial: false,
			Status: 416,
			Start: 0,
			End: 0,
			Length: 0,
			ContentRange: `bytes */${tmpSize}`
		}
	);

	// A zero-length file cannot satisfy any byte range.
	if (tmpSize === 0)
	{
		return fnUnsatisfiable();
	}

	let tmpStart;
	let tmpEnd;

	if (tmpStartRaw === '' && tmpEndRaw === '')
	{
		// "bytes=-" is malformed.
		return fnUnsatisfiable();
	}
	else if (tmpStartRaw === '')
	{
		// Suffix range: the final N bytes.
		let tmpSuffix = parseInt(tmpEndRaw, 10);
		if (!(tmpSuffix > 0))
		{
			return fnUnsatisfiable();
		}
		tmpStart = Math.max(0, tmpSize - tmpSuffix);
		tmpEnd = tmpSize - 1;
	}
	else
	{
		tmpStart = parseInt(tmpStartRaw, 10);
		tmpEnd = (tmpEndRaw === '') ? (tmpSize - 1) : parseInt(tmpEndRaw, 10);
	}

	// Clamp the end to the last byte.
	if (tmpEnd > tmpSize - 1)
	{
		tmpEnd = tmpSize - 1;
	}

	if (!(tmpStart >= 0) || tmpStart > tmpEnd || tmpStart >= tmpSize)
	{
		return fnUnsatisfiable();
	}

	return {
		Satisfiable: true,
		Partial: true,
		Status: 206,
		Start: tmpStart,
		End: tmpEnd,
		Length: tmpEnd - tmpStart + 1,
		ContentRange: `bytes ${tmpStart}-${tmpEnd}/${tmpSize}`
	};
}

/**
 * Serve a file over HTTP, honoring a Range header. Streams the bytes (never
 * buffers the whole file), sets Accept-Ranges / Content-Range / Content-Length
 * and a Content-Type, and handles HEAD (headers only) and 416.
 *
 * The response object only needs `writeHead(status, headers)` and to be a
 * Writable sink (so a read stream can `.pipe()` into it) plus `end()` -- a
 * Node http.ServerResponse, a restify response, or a plain Writable in tests.
 *
 * @param {Object} pResponse - The HTTP response (Writable with writeHead/end).
 * @param {string} pAbsolutePath - Absolute path to the file on disk.
 * @param {Object} [pOptions] - Serving options.
 * @param {string} [pOptions.RangeHeader] - The Range request header value.
 * @param {string} [pOptions.Method='GET'] - The request method (HEAD = no body).
 * @param {string} [pOptions.MIMEType] - Explicit Content-Type (else detected).
 * @param {string} [pOptions.DownloadName] - If set, Content-Disposition attachment.
 * @param {string} [pOptions.CacheControl] - Cache-Control header value.
 * @param {Object} [pOptions.FS] - Injectable fs module (default node:fs).
 * @param {Object} [pOptions.ExtraHeaders] - Additional response headers to merge.
 * @param {function} [fCallback] - Callback(error). Called with an error when the
 *   file is missing/unreadable (so the caller can emit a 404) or on a stream
 *   error; called with null once the response has been dispatched.
 * @returns {void}
 */
function serveFile(pResponse, pAbsolutePath, pOptions, fCallback)
{
	let tmpOptions = pOptions || {};
	let tmpFS = tmpOptions.FS || libFS;
	let tmpCallback = (typeof fCallback === 'function') ? fCallback : () => {};
	let tmpMethod = (tmpOptions.Method || 'GET').toUpperCase();

	let tmpStat;
	try
	{
		tmpStat = tmpFS.statSync(pAbsolutePath);
	}
	catch (pError)
	{
		return tmpCallback(pError);
	}

	if (!tmpStat || !tmpStat.isFile())
	{
		return tmpCallback(new Error(`Not a file: ${pAbsolutePath}`));
	}

	let tmpSize = tmpStat.size;
	let tmpPlan = planByteRange(tmpSize, tmpOptions.RangeHeader);

	let tmpMIMEType = tmpOptions.MIMEType || detectMIMEType(pAbsolutePath);

	let tmpHeaders = Object.assign(
		{
			'Accept-Ranges': 'bytes',
			'Content-Type': tmpMIMEType
		},
		tmpOptions.ExtraHeaders || {});

	if (tmpOptions.CacheControl)
	{
		tmpHeaders['Cache-Control'] = tmpOptions.CacheControl;
	}
	if (tmpOptions.DownloadName)
	{
		tmpHeaders['Content-Disposition'] = `attachment; filename="${String(tmpOptions.DownloadName).replace(/"/g, '')}"`;
	}
	if (tmpOptions.LastModified !== false && tmpStat.mtime)
	{
		tmpHeaders['Last-Modified'] = tmpStat.mtime.toUTCString();
	}

	// Unsatisfiable range -> 416 with Content-Range: bytes */size.
	if (!tmpPlan.Satisfiable)
	{
		tmpHeaders['Content-Range'] = tmpPlan.ContentRange;
		tmpHeaders['Content-Length'] = 0;
		try
		{
			pResponse.writeHead(416, tmpHeaders);
			pResponse.end();
		}
		catch (pWriteError)
		{
			return tmpCallback(pWriteError);
		}
		return tmpCallback(null);
	}

	tmpHeaders['Content-Length'] = tmpPlan.Length;
	if (tmpPlan.Partial)
	{
		tmpHeaders['Content-Range'] = tmpPlan.ContentRange;
	}

	// HEAD (or an empty representation) -> headers only, no body.
	if (tmpMethod === 'HEAD' || tmpPlan.Length === 0)
	{
		try
		{
			pResponse.writeHead(tmpPlan.Status, tmpHeaders);
			pResponse.end();
		}
		catch (pWriteError)
		{
			return tmpCallback(pWriteError);
		}
		return tmpCallback(null);
	}

	try
	{
		pResponse.writeHead(tmpPlan.Status, tmpHeaders);
	}
	catch (pWriteError)
	{
		return tmpCallback(pWriteError);
	}

	let tmpStream;
	try
	{
		tmpStream = tmpFS.createReadStream(pAbsolutePath, { start: tmpPlan.Start, end: tmpPlan.End });
	}
	catch (pStreamError)
	{
		return tmpCallback(pStreamError);
	}

	let tmpSettled = false;
	tmpStream.on('error', (pStreamError) =>
	{
		if (tmpSettled)
		{
			return;
		}
		tmpSettled = true;
		try { pResponse.end(); } catch (pEndError) { /* response already torn down */ }
		return tmpCallback(pStreamError);
	});
	tmpStream.on('end', () =>
	{
		if (tmpSettled)
		{
			return;
		}
		tmpSettled = true;
		return tmpCallback(null);
	});

	tmpStream.pipe(pResponse);
}

module.exports = {
	planByteRange: planByteRange,
	serveFile: serveFile,
	detectMIMEType: detectMIMEType,
	DEFAULT_MIME_TYPE: DEFAULT_MIME_TYPE
};
