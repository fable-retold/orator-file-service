/**
* Unit tests for the Orator File Service Range byte server.
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
const libStream = require('node:stream');

const libRangeServer = require('../source/File-Range-Server.js');

// A Writable that records writeHead() and collects the piped body so a
// response can be asserted on without a live HTTP server.
class CollectorResponse extends libStream.Writable
{
	constructor()
	{
		super();
		this.statusCode = false;
		this.headers = false;
		this.chunks = [];
		this.ended = false;
	}

	writeHead(pStatus, pHeaders)
	{
		this.statusCode = pStatus;
		this.headers = pHeaders;
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
		this.ended = true;
		return super.end();
	}

	get body()
	{
		return Buffer.concat(this.chunks);
	}
}

suite
(
	'Orator File Service -- File-Range-Server',
	() =>
	{
		suite
		(
			'planByteRange (pure)',
			() =>
			{
				test
				(
					'no range header serves the full representation (200)',
					() =>
					{
						let tmpPlan = libRangeServer.planByteRange(1000);
						Expect(tmpPlan.Status).to.equal(200);
						Expect(tmpPlan.Partial).to.equal(false);
						Expect(tmpPlan.Start).to.equal(0);
						Expect(tmpPlan.End).to.equal(999);
						Expect(tmpPlan.Length).to.equal(1000);
						Expect(tmpPlan.ContentRange).to.equal(false);
					}
				);

				test
				(
					'a closed range yields 206 with Content-Range',
					() =>
					{
						let tmpPlan = libRangeServer.planByteRange(1000, 'bytes=0-499');
						Expect(tmpPlan.Status).to.equal(206);
						Expect(tmpPlan.Partial).to.equal(true);
						Expect(tmpPlan.Start).to.equal(0);
						Expect(tmpPlan.End).to.equal(499);
						Expect(tmpPlan.Length).to.equal(500);
						Expect(tmpPlan.ContentRange).to.equal('bytes 0-499/1000');
					}
				);

				test
				(
					'an open-ended range runs to the last byte',
					() =>
					{
						let tmpPlan = libRangeServer.planByteRange(1000, 'bytes=500-');
						Expect(tmpPlan.Status).to.equal(206);
						Expect(tmpPlan.Start).to.equal(500);
						Expect(tmpPlan.End).to.equal(999);
						Expect(tmpPlan.Length).to.equal(500);
						Expect(tmpPlan.ContentRange).to.equal('bytes 500-999/1000');
					}
				);

				test
				(
					'a suffix range returns the final N bytes',
					() =>
					{
						let tmpPlan = libRangeServer.planByteRange(1000, 'bytes=-200');
						Expect(tmpPlan.Status).to.equal(206);
						Expect(tmpPlan.Start).to.equal(800);
						Expect(tmpPlan.End).to.equal(999);
						Expect(tmpPlan.Length).to.equal(200);
						Expect(tmpPlan.ContentRange).to.equal('bytes 800-999/1000');
					}
				);

				test
				(
					'a suffix larger than the file clamps to the whole file',
					() =>
					{
						let tmpPlan = libRangeServer.planByteRange(1000, 'bytes=-5000');
						Expect(tmpPlan.Status).to.equal(206);
						Expect(tmpPlan.Start).to.equal(0);
						Expect(tmpPlan.End).to.equal(999);
						Expect(tmpPlan.Length).to.equal(1000);
					}
				);

				test
				(
					'an end past the file size is clamped to the last byte',
					() =>
					{
						let tmpPlan = libRangeServer.planByteRange(1000, 'bytes=900-99999');
						Expect(tmpPlan.Status).to.equal(206);
						Expect(tmpPlan.Start).to.equal(900);
						Expect(tmpPlan.End).to.equal(999);
						Expect(tmpPlan.Length).to.equal(100);
					}
				);

				test
				(
					'a start at or past EOF is unsatisfiable (416)',
					() =>
					{
						let tmpPlan = libRangeServer.planByteRange(1000, 'bytes=1000-1200');
						Expect(tmpPlan.Satisfiable).to.equal(false);
						Expect(tmpPlan.Status).to.equal(416);
						Expect(tmpPlan.ContentRange).to.equal('bytes */1000');
					}
				);

				test
				(
					'a malformed "bytes=-" range is unsatisfiable',
					() =>
					{
						let tmpPlan = libRangeServer.planByteRange(1000, 'bytes=-');
						Expect(tmpPlan.Status).to.equal(416);
					}
				);

				test
				(
					'a non-bytes unit is ignored and the full file is served',
					() =>
					{
						let tmpPlan = libRangeServer.planByteRange(1000, 'items=0-10');
						Expect(tmpPlan.Status).to.equal(200);
						Expect(tmpPlan.Partial).to.equal(false);
					}
				);

				test
				(
					'a zero-length file cannot satisfy a byte range',
					() =>
					{
						let tmpPlan = libRangeServer.planByteRange(0, 'bytes=0-10');
						Expect(tmpPlan.Status).to.equal(416);
						Expect(tmpPlan.ContentRange).to.equal('bytes */0');
					}
				);
			}
		);

		suite
		(
			'serveFile (IO)',
			() =>
			{
				let _tmpDir = false;
				let _tmpFile = false;
				const _Payload = Buffer.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 'utf8'); // 36 bytes

				setup
				(
					() =>
					{
						_tmpDir = libFS.mkdtempSync(libPath.join(libOS.tmpdir(), 'ofs-range-'));
						_tmpFile = libPath.join(_tmpDir, 'payload.txt');
						libFS.writeFileSync(_tmpFile, _Payload);
					}
				);

				teardown
				(
					() =>
					{
						try { libFS.rmSync(_tmpDir, { recursive: true, force: true }); }
						catch (pError) { /* best-effort cleanup */ }
					}
				);

				test
				(
					'a full GET streams every byte with a 200 and Accept-Ranges',
					(fDone) =>
					{
						let tmpResponse = new CollectorResponse();
						libRangeServer.serveFile(tmpResponse, _tmpFile, { Method: 'GET', MIMEType: 'text/plain' },
							(pError) =>
							{
								Expect(pError).to.equal(null);
								Expect(tmpResponse.statusCode).to.equal(200);
								Expect(tmpResponse.headers['Accept-Ranges']).to.equal('bytes');
								Expect(tmpResponse.headers['Content-Length']).to.equal(36);
								Expect(tmpResponse.headers['Content-Type']).to.equal('text/plain');
								Expect(tmpResponse.body.toString('utf8')).to.equal(_Payload.toString('utf8'));
								return fDone();
							});
					}
				);

				test
				(
					'a ranged GET streams exactly the requested slice with a 206',
					(fDone) =>
					{
						let tmpResponse = new CollectorResponse();
						libRangeServer.serveFile(tmpResponse, _tmpFile, { Method: 'GET', RangeHeader: 'bytes=5-9' },
							(pError) =>
							{
								Expect(pError).to.equal(null);
								Expect(tmpResponse.statusCode).to.equal(206);
								Expect(tmpResponse.headers['Content-Range']).to.equal('bytes 5-9/36');
								Expect(tmpResponse.headers['Content-Length']).to.equal(5);
								Expect(tmpResponse.body.toString('utf8')).to.equal('FGHIJ');
								return fDone();
							});
					}
				);

				test
				(
					'a HEAD sends headers but no body',
					(fDone) =>
					{
						let tmpResponse = new CollectorResponse();
						libRangeServer.serveFile(tmpResponse, _tmpFile, { Method: 'HEAD' },
							(pError) =>
							{
								Expect(pError).to.equal(null);
								Expect(tmpResponse.statusCode).to.equal(200);
								Expect(tmpResponse.headers['Content-Length']).to.equal(36);
								Expect(tmpResponse.body.length).to.equal(0);
								return fDone();
							});
					}
				);

				test
				(
					'an unsatisfiable range sends a 416 with Content-Range',
					(fDone) =>
					{
						let tmpResponse = new CollectorResponse();
						libRangeServer.serveFile(tmpResponse, _tmpFile, { RangeHeader: 'bytes=100-200' },
							(pError) =>
							{
								Expect(pError).to.equal(null);
								Expect(tmpResponse.statusCode).to.equal(416);
								Expect(tmpResponse.headers['Content-Range']).to.equal('bytes */36');
								Expect(tmpResponse.body.length).to.equal(0);
								return fDone();
							});
					}
				);

				test
				(
					'a DownloadName sets a Content-Disposition attachment header',
					(fDone) =>
					{
						let tmpResponse = new CollectorResponse();
						libRangeServer.serveFile(tmpResponse, _tmpFile, { DownloadName: 'report.txt', CacheControl: 'public, max-age=60' },
							(pError) =>
							{
								Expect(pError).to.equal(null);
								Expect(tmpResponse.headers['Content-Disposition']).to.equal('attachment; filename="report.txt"');
								Expect(tmpResponse.headers['Cache-Control']).to.equal('public, max-age=60');
								return fDone();
							});
					}
				);

				test
				(
					'a missing file calls back with an error (so the caller can 404)',
					(fDone) =>
					{
						let tmpResponse = new CollectorResponse();
						libRangeServer.serveFile(tmpResponse, libPath.join(_tmpDir, 'nope.txt'), {},
							(pError) =>
							{
								Expect(pError).to.be.an('error');
								Expect(tmpResponse.statusCode).to.equal(false);
								return fDone();
							});
					}
				);
			}
		);
	}
);
