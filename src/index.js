// Public surface of http-trailer-field-ts. Everything callers need is re-exported
// here so that a single import path is enough.
export {
  TRAILER_END,
  findTrailerStart,
  splitTrailer,
  parseTrailerFields,
  trailerField,
  collectTrailerFields,
  TrailerStream,
} from "./core.js";
