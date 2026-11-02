// http-trailer-field-ts
//
// Splits a chunked transfer response body from its trailing headers when using
// fetch streams.
//
// The WHATWG fetch API exposes the decoded body of a chunked response as a
// ReadableStream of Uint8Array chunks. It does not expose the trailer section:
// the body stream simply ends after the last chunk. Trailer fields such as
// `Digest` or `X-Content-Checksum` arrive after the terminating zero-length
// chunk and are dropped on the floor by most runtimes.
//
// This module keeps the raw framing contract in one place. It does not try to
// decode chunk sizes or de-chunk the payload; that is the job of the transport
// (fetch, undici, a test double). What it does is find the boundary between the
// last payload byte and the trailer section, and parse the trailer section into
// a field map. The transport is expected to have already removed the chunk
// framing and the CRLF that terminates the body.

// The trailer section is separated from the body by a CRLF CRLF sequence, the
// same blank line that ends a header block. We look for it from the end because
// a body may legitimately contain that byte sequence near the start, while the
// trailer terminator is always the final blank line in the stream.
export const TRAILER_END = new Uint8Array([0x0d, 0x0a, 0x0d, 0x0a]);

/**
 * Find the byte offset at which the trailer section begins, or -1 when the
 * body contains no trailer terminator.
 *
 * We search from the end so that a body containing CRLFCRLF is not mistaken for
 * the trailer separator. The returned index points at the first CR of the
 * final CRLFCRLF; the trailer bytes start at index + 4.
 *
 * @param {Uint8Array} bytes raw response bytes with chunk framing removed
 * @returns {number} index of the trailer separator, or -1
 */
export function findTrailerStart(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("bytes must be a Uint8Array");
  }
  const [a, b, c, d] = TRAILER_END;
  for (let i = bytes.length - 4; i >= 0; i -= 1) {
    if (bytes[i] === a && bytes[i + 1] === b && bytes[i + 2] === c && bytes[i + 3] === d) {
      return i;
    }
  }
  return -1;
}

/**
 * Split raw response bytes into the payload and the raw trailer block.
 *
 * The trailer block excludes the separating CRLFCRLF. When no separator is
 * present the whole input is treated as body and the trailer block is empty.
 * That is the documented interpretation: a stream without a trailing blank
 * line has no trailer section, and we do not guess.
 *
 * @param {Uint8Array} bytes
 * @returns {{ body: Uint8Array, trailer: Uint8Array }}
 */
export function splitTrailer(bytes) {
  const at = findTrailerStart(bytes);
  if (at === -1) {
    return { body: bytes, trailer: new Uint8Array(0) };
  }
  return {
    body: bytes.subarray(0, at),
    trailer: bytes.subarray(at + 4),
  };
}

/**
 * Parse a raw trailer block into a field map.
 *
 * Field names are lower-cased and repeated names are joined with ", " in the
 * order they appear, matching the way fetch combines repeated headers. Lines
 * are CRLF separated; a bare LF is also accepted because some proxies rewrite
 * line endings. Leading and trailing whitespace around the value is stripped.
 *
 * Malformed lines without a colon are skipped rather than throwing: a trailer
 * section is advisory metadata and a single bad line should not destroy an
 * otherwise usable response.
 *
 * @param {Uint8Array} trailer
 * @returns {Map<string, string>}
 */
export function parseTrailerFields(trailer) {
  if (!(trailer instanceof Uint8Array)) {
    throw new TypeError("trailer must be a Uint8Array");
  }
  const fields = new Map();
  const text = new TextDecoder("latin1").decode(trailer);
  const lines = text.split(/\r\n|\n/);
  for (const line of lines) {
    if (line.length === 0) {
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) {
      continue;
    }
    const name = line.slice(0, colon).trim().toLowerCase();
    if (name.length === 0) {
      continue;
    }
    const value = line.slice(colon + 1).trim();
    if (fields.has(name)) {
      fields.set(name, `${fields.get(name)}, ${value}`);
    } else {
      fields.set(name, value);
    }
  }
  return fields;
}

/**
 * Read a single trailer field by name. The lookup is case-insensitive because
 * trailer field names are HTTP header names.
 *
 * @param {Map<string, string>} fields
 * @param {string} name
 * @returns {string | undefined}
 */
export function trailerField(fields, name) {
  if (!(fields instanceof Map)) {
    throw new TypeError("fields must be a Map");
  }
  return fields.get(String(name).toLowerCase());
}

/**
 * Convenience helper: split and parse in one call.
 *
 * @param {Uint8Array} bytes
 * @returns {{ body: Uint8Array, fields: Map<string, string> }}
 */
export function collectTrailerFields(bytes) {
  const { body, trailer } = splitTrailer(bytes);
  return { body, fields: parseTrailerFields(trailer) };
}

/**
 * Incremental splitter for fetch streams.
 *
 * The awkward edge is that the CRLFCRLF separator can straddle two chunks, so
 * a naive per-chunk search misses it. This class buffers bytes and only emits
 * body once it is sure the separator has not started in the buffered tail. It
 * keeps the last three bytes back because those are the longest suffix that
 * could still turn into a separator when the next chunk arrives.
 *
 * The caller feeds Uint8Array chunks and calls finish() at end of stream. Body
 * bytes are yielded through the onBody callback in arrival order; the trailer
 * section is parsed once and returned from finish(). If no separator is ever
 * seen, the entire input is body and the field map is empty.
 */
export class TrailerStream {
  /**
   * @param {(chunk: Uint8Array) => void} onBody
   */
  constructor(onBody) {
    if (typeof onBody !== "function") {
      throw new TypeError("onBody must be a function");
    }
    this._onBody = onBody;
    this._pending = new Uint8Array(0);
    this._done = false;
  }

  /**
   * Feed one chunk of de-framed body bytes.
   * @param {Uint8Array} chunk
   */
  push(chunk) {
    if (this._done) {
      throw new Error("push after finish");
    }
    if (!(chunk instanceof Uint8Array)) {
      throw new TypeError("chunk must be a Uint8Array");
    }
    if (chunk.length === 0) {
      return;
    }
    const combined = new Uint8Array(this._pending.length + chunk.length);
    combined.set(this._pending, 0);
    combined.set(chunk, this._pending.length);

    const at = findTrailerStart(combined);
    if (at !== -1) {
      if (at > 0) {
        this._onBody(combined.subarray(0, at));
      }
      this._trailer = combined.subarray(at + 4);
      this._pending = new Uint8Array(0);
      this._done = true;
      return;
    }

    // Hold back up to three bytes: a separator may begin in the tail we have
    // already seen and complete in the next chunk.
    const flush = Math.max(0, combined.length - 3);
    if (flush > 0) {
      this._onBody(combined.subarray(0, flush));
    }
    this._pending = combined.subarray(flush);
  }

  /**
   * Signal end of stream. Any bytes still held back are body bytes, because a
   * separator that never completed is not a separator.
   * @returns {Map<string, string>}
   */
  finish() {
    if (!this._done) {
      if (this._pending.length > 0) {
        this._onBody(this._pending);
      }
      this._pending = new Uint8Array(0);
      this._trailer = new Uint8Array(0);
      this._done = true;
    }
    return parseTrailerFields(this._trailer);
  }
}
