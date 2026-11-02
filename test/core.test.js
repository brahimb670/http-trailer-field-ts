import test from "node:test";
import assert from "node:assert/strict";

import {
  TRAILER_END,
  findTrailerStart,
  splitTrailer,
  parseTrailerFields,
  trailerField,
  collectTrailerFields,
  TrailerStream,
} from "../src/index.js";

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder("latin1").decode(b);

const SEP = "\r\n\r\n";

test("TRAILER_END is CRLFCRLF", () => {
  assert.deepEqual(Array.from(TRAILER_END), [0x0d, 0x0a, 0x0d, 0x0a]);
});

test("findTrailerStart returns -1 when there is no separator", () => {
  assert.equal(findTrailerStart(enc("hello world")), -1);
});

test("findTrailerStart finds the final separator when the body repeats it", () => {
  const bytes = enc(`body${SEP}still body${SEP}Digest: sha-256=abc`);
  const at = findTrailerStart(bytes);
  assert.notEqual(at, -1);
  assert.equal(dec(bytes.subarray(at + 4)), "Digest: sha-256=abc");
});

test("findTrailerStart rejects non-Uint8Array input", () => {
  assert.throws(() => findTrailerStart("nope"), TypeError);
});

test("splitTrailer separates body and trailer", () => {
  const bytes = enc(`payload${SEP}X-Checksum: 1234`);
  const { body, trailer } = splitTrailer(bytes);
  assert.equal(dec(body), "payload");
  assert.equal(dec(trailer), "X-Checksum: 1234");
});

test("splitTrailer treats input without separator as all body", () => {
  const bytes = enc("just a body");
  const { body, trailer } = splitTrailer(bytes);
  assert.equal(dec(body), "just a body");
  assert.equal(trailer.length, 0);
});

test("parseTrailerFields lower-cases names and trims values", () => {
  const fields = parseTrailerFields(enc("Digest:   sha-256=abc  \r\nX-Trace: 42"));
  assert.equal(fields.get("digest"), "sha-256=abc");
  assert.equal(fields.get("x-trace"), "42");
});

test("parseTrailerFields joins repeated names in order", () => {
  const fields = parseTrailerFields(enc("X-Multi: a\r\nX-Multi: b\r\nX-Multi: c"));
  assert.equal(fields.get("x-multi"), "a, b, c");
});

test("parseTrailerFields accepts bare LF line endings", () => {
  const fields = parseTrailerFields(enc("A: 1\nB: 2"));
  assert.equal(fields.get("a"), "1");
  assert.equal(fields.get("b"), "2");
});

test("parseTrailerFields skips malformed and empty-name lines", () => {
  const fields = parseTrailerFields(enc("no-colon-here\r\n: missing-name\r\nGood: yes"));
  assert.equal(fields.size, 1);
  assert.equal(fields.get("good"), "yes");
});

test("parseTrailerFields rejects non-Uint8Array input", () => {
  assert.throws(() => parseTrailerFields("nope"), TypeError);
});

test("trailerField looks up case-insensitively", () => {
  const fields = parseTrailerFields(enc("Digest: sha-256=abc"));
  assert.equal(trailerField(fields, "DIGEST"), "sha-256=abc");
  assert.equal(trailerField(fields, "missing"), undefined);
});

test("trailerField rejects a non-Map", () => {
  assert.throws(() => trailerField({}, "x"), TypeError);
});

test("collectTrailerFields splits and parses in one call", () => {
  const { body, fields } = collectTrailerFields(enc(`data${SEP}Digest: sha-256=abc`));
  assert.equal(dec(body), "data");
  assert.equal(fields.get("digest"), "sha-256=abc");
});

test("TrailerStream emits body and parses trailer across chunk boundaries", () => {
  const chunks = [];
  const stream = new TrailerStream((c) => chunks.push(c));
  stream.push(enc("hello "));
  stream.push(enc("world\r"));
  stream.push(enc("\n\r\nDigest: sha-256=abc"));
  const fields = stream.finish();
  assert.equal(dec(concat(chunks)), "hello world");
  assert.equal(fields.get("digest"), "sha-256=abc");
});

test("TrailerStream flushes held-back bytes when no separator appears", () => {
  const chunks = [];
  const stream = new TrailerStream((c) => chunks.push(c));
  stream.push(enc("abc"));
  stream.push(enc("def"));
  const fields = stream.finish();
  assert.equal(dec(concat(chunks)), "abcdef");
  assert.equal(fields.size, 0);
});

test("TrailerStream handles an empty body before the separator", () => {
  const chunks = [];
  const stream = new TrailerStream((c) => chunks.push(c));
  stream.push(enc(SEP + "X: 1"));
  const fields = stream.finish();
  assert.equal(concat(chunks).length, 0);
  assert.equal(fields.get("x"), "1");
});

test("TrailerStream rejects push after finish", () => {
  const stream = new TrailerStream(() => {});
  stream.finish();
  assert.throws(() => stream.push(enc("x")), /push after finish/);
});

test("TrailerStream rejects a non-function onBody", () => {
  assert.throws(() => new TrailerStream(null), TypeError);
});

function concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
