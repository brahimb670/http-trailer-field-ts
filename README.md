# http-trailer-field-ts

Splits a chunked transfer response body from its trailing headers when using fetch streams.

```js
import {
  TrailerStream,
  collectTrailerFields,
  splitTrailer,
  parseTrailerFields,
  trailerField,
} from "http-trailer-field-ts";

// One-shot: you already have the de-framed response bytes.
const raw = new TextEncoder().encode("payload\r\n\r\nDigest: sha-256=abc");
const { body, fields } = collectTrailerFields(raw);
console.log(new TextDecoder().decode(body)); // "payload"
console.log(fields.get("digest")); // "sha-256=abc"

// Streaming: feed chunks as they arrive. The separator may straddle chunks.
const out = [];
const stream = new TrailerStream((chunk) => out.push(chunk));
stream.push(new TextEncoder().encode("pay"));
stream.push(new TextEncoder().encode("load\r\n\r\nDigest: sha-256=abc"));
const trailer = stream.finish();
console.log(trailer.get("digest")); // "sha-256=abc"

// Lower-level pieces are exported too.
const parts = splitTrailer(raw);
console.log(parseTrailerFields(parts.trailer).get("digest"));
console.log(trailerField(fields, "DIGEST")); // case-insensitive lookup
```

## Why this exists

`fetch` exposes a chunked response body as a `ReadableStream` of `Uint8Array` chunks and then
ends the stream. Trailer fields, which arrive after the terminating zero-length chunk, are not
surfaced at all. If you need a `Digest` or a checksum that only travels in the trailer, you have
to recover it yourself from the bytes.

The trade-off: this library does not de-chunk. It assumes the transport has already removed the
chunk-size lines and the framing, and that what you hand it is the concatenated payload followed
by the trailer section separated by a blank line. That keeps the code small and keeps the framing
logic where it belongs, but it means you cannot point it at a raw socket stream and expect it to
work. If you have raw chunked framing, strip it first.

## The awkward edge

The separator is `CRLF CRLF`, and a body may contain that byte sequence. We resolve it by
searching from the end: the last `CRLF CRLF` in the stream is the trailer boundary. A body that
ends with `CRLF CRLF` and no trailer section will therefore be split, and its tail will be parsed
as fields. If your payload can end that way and you have no trailer, call `findTrailerStart`
first and decide for yourself.

`TrailerStream` holds back the last three bytes of each chunk, because a separator can begin in
one chunk and finish in the next. Those bytes are emitted as body at `finish()` if no separator
ever completes.

## API

- `TRAILER_END` — `Uint8Array` of `[0x0d, 0x0a, 0x0d, 0x0a]`.
- `findTrailerStart(bytes)` — index of the final separator, or `-1`.
- `splitTrailer(bytes)` — `{ body, trailer }`, both `Uint8Array`.
- `parseTrailerFields(trailer)` — `Map<string, string>`, names lower-cased, repeats joined with `", "`.
- `trailerField(fields, name)` — case-insensitive lookup, or `undefined`.
- `collectTrailerFields(bytes)` — `{ body, fields }`.
- `TrailerStream` — `new TrailerStream(onBody)`, `push(chunk)`, `finish()` returns the field map.
