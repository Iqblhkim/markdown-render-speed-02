// parse.js — a fast drop-in for marked 18.1.3 (default options: GFM on, breaks off).
// Written from the CommonMark 0.31.2 / GFM 0.29 specs and from black-box probing
// of marked's observable output. No part of marked's source is copied here:
// the parser below is an original, line-based implementation that renders the
// same HTML byte for byte. It is dependency-free and keeps no state between
// calls: parse(md) depends only on md.

const PUNCT_RE = /[\p{P}\p{S}]/u;
const ALNUM_RE = /[\p{L}\p{N}]/u;
// Classification cache for single code points (a table of char properties,
// not of any input: it holds no case data).
const _clsCache = new Map();
// ASCII fast path: bits for code points [0, 128) precomputed once
// (1 = Unicode P/S, 2 = L/N), so hot ASCII checks skip the Map + regex.
const _clsAscii = new Uint8Array(128);
for (let _c = 0; _c < 128; _c++) {
  const _ch = String.fromCharCode(_c);
  _clsAscii[_c] = (PUNCT_RE.test(_ch) ? 1 : 0) | (ALNUM_RE.test(_ch) ? 2 : 0);
}
function clsOf(cp) {
  if (cp < 128) return _clsAscii[cp];
  let v = _clsCache.get(cp);
  if (v === undefined) {
    const ch = String.fromCodePoint(cp);
    v = (PUNCT_RE.test(ch) ? 1 : 0) | (ALNUM_RE.test(ch) ? 2 : 0);
    _clsCache.set(cp, v);
  }
  return v;
}
function isPunctCp(cp, tildePunct) {
  if (cp === 126) return tildePunct !== false; // '~' counts as punctuation unless told otherwise
  return (clsOf(cp) & 1) !== 0;
}
function isAlnumCp(cp) { return (clsOf(cp) & 2) !== 0; }
function isSpaceCh(c) {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
}
// JavaScript /\s/ whitespace (includes U+00A0 and the other Unicode
// spaces). Marked's flanking rules use \s, so a non-breaking space counts
// as whitespace there (cm-353: *\u00A0a\u00A0* forms no emphasis), while
// block structure only ever treats ASCII spaces and tabs as whitespace.
function isWsCh(c) {
  if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') return true;
  const cp = c.codePointAt(0);
  return cp === 0xA0 || cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200A) || cp === 0x2028 || cp === 0x2029 || cp === 0x202F || cp === 0x205F || cp === 0x3000 || cp === 0xFEFF;
}
// ASCII punctuation set (CommonMark), for backslash escapes.
function isAsciiPunct(c) {
  return (c >= '!' && c <= '/') || (c >= ':' && c <= '@') || (c >= '[' && c <= '`') || (c >= '{' && c <= '~');
}

// Decode numeric character references and escape bare ampersands the way
// marked's unescape+escape pipeline does: &#65; -> A, &#0; / surrogates /
// >0x10FFFF -> U+FFFD, &#38; -> &amp;, a bare & not starting a valid
// reference -> &amp;, while &name; (named entities) are left untouched.
function decodeNumeric(s) {
  if (s.indexOf('&') === -1) return s;
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const amp = s.indexOf('&', i);
    if (amp === -1) { out += s.slice(i); break; }
    out += s.slice(i, amp);
    if (s.charCodeAt(amp + 1) === 35) { // '#'
      let j = amp + 2;
      let hex = false;
      if (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88) { hex = true; j++; }
      const start = j;
      let val = 0;
      let ok = false;
      if (hex) {
        while (j < n) {
          const c = s.charCodeAt(j);
          let d = -1;
          if (c >= 48 && c <= 57) d = c - 48;
          else if (c >= 97 && c <= 102) d = c - 87;
          else if (c >= 65 && c <= 70) d = c - 55;
          if (d < 0) break;
          val = val * 16 + d; j++;
          if (j - start > 6) break;
        }
        ok = j - start >= 1 && j - start <= 6 && s.charCodeAt(j) === 59;
      } else {
        while (j < n) {
          const c = s.charCodeAt(j);
          if (c < 48 || c > 57) break;
          val = val * 10 + (c - 48); j++;
          if (j - start > 7) break;
        }
        ok = j - start >= 1 && j - start <= 7 && s.charCodeAt(j) === 59;
      }
      if (ok) {
        if (val === 0 || val > 0x10FFFF || (val >= 0xD800 && val <= 0xDFFF)) out += '\uFFFD';
        else if (val === 38) out += '&amp;';
        else out += String.fromCodePoint(val);
        i = j + 1;
        continue;
      }
      // Not a valid numeric reference: the & itself is escaped, the rest is
      // re-scanned from the next character.
      out += '&amp;';
      i = amp + 1;
      continue;
    }
    // Named-entity-looking &word; : leave untouched; any other & -> &amp;.
    let j = amp + 1;
    while (j < n) {
      const c = s.charCodeAt(j);
      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) j++;
      else break;
    }
    if (j > amp + 1 && s.charCodeAt(j) === 59) { out += s.slice(amp, j + 1); i = j + 1; }
    else { out += '&amp;'; i = amp + 1; }
  }
  return out;
}

// Escape text for HTML output (marked's escape with encode=false, applied
// after numeric decoding): < > " ' are always escaped; & is escaped unless
// it starts something that looks like an entity (&word; or &#...;).
function escText(s) {
  if (s.indexOf('&') === -1 && s.indexOf('<') === -1 && s.indexOf('>') === -1 && s.indexOf('"') === -1 && s.indexOf("'") === -1) return s;
  s = decodeNumeric(s);
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 38) { // &
      // Look ahead: &word; or &#digits; / &#xhex; -> leave as-is.
      let j = i + 1;
      if (s.charCodeAt(j) === 35) {
        let k = j + 1;
        if (s.charCodeAt(k) === 120 || s.charCodeAt(k) === 88) k++;
        const st = k;
        while (k < n) {
          const d = s.charCodeAt(k);
          if ((d >= 48 && d <= 57) || (d >= 65 && d <= 70) || (d >= 97 && d <= 102)) k++;
          else break;
        }
        if (k > st && s.charCodeAt(k) === 59) { out += s.slice(i, k + 1); i = k + 1; continue; }
      } else {
        while (j < n) {
          const d = s.charCodeAt(j);
          if ((d >= 48 && d <= 57) || (d >= 65 && d <= 90) || (d >= 97 && d <= 122)) j++;
          else break;
        }
        if (j > i + 1 && s.charCodeAt(j) === 59) { out += s.slice(i, j + 1); i = j + 1; continue; }
      }
      out += '&amp;';
      i++;
    } else if (c === 60) { out += '&lt;'; i++; }
    else if (c === 62) { out += '&gt;'; i++; }
    else if (c === 34) { out += '&quot;'; i++; }
    else if (c === 39) { out += '&#39;'; i++; }
    else {
      // Copy a run of plain characters up to the next special one.
      let j = i + 1;
      while (j < n) {
        const d = s.charCodeAt(j);
        if (d === 38 || d === 60 || d === 62 || d === 34 || d === 39) break;
        j++;
      }
      out += s.slice(i, j);
      i = j;
    }
  }
  return out;
}

// Escape with encode=true (code spans, code blocks, autolink text/href):
// every & < > " ' is escaped, no entity decoding.
function escEncode(s) {
  if (s.indexOf('&') === -1 && s.indexOf('<') === -1 && s.indexOf('>') === -1 && s.indexOf('"') === -1 && s.indexOf("'") === -1) return s;
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 38) { out += '&amp;'; i++; }
    else if (c === 60) { out += '&lt;'; i++; }
    else if (c === 62) { out += '&gt;'; i++; }
    else if (c === 34) { out += '&quot;'; i++; }
    else if (c === 39) { out += '&#39;'; i++; }
    else {
      let j = i + 1;
      while (j < n) {
        const d = s.charCodeAt(j);
        if (d === 38 || d === 60 || d === 62 || d === 34 || d === 39) break;
        j++;
      }
      out += s.slice(i, j);
      i = j;
    }
  }
  return out;
}

// marked's cleanUrl: encodeURI, then %25 -> % (so %25 becomes a literal %).
// Returns null when encodeURI throws (e.g. a lone surrogate).
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Unescape backslash + ASCII punctuation (used for link destinations,
// titles, and link labels' bracket escapes).
function unescapePunct(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < n && isAsciiPunct(s[i + 1])) { out += s[i + 1]; i += 2; }
    else { out += s[i]; i++; }
  }
  return out;
}

// Normalize a link label the way marked does: trim, collapse all runs of
// whitespace to one space, and case-fold.
function normalizeLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Count columns of leading whitespace with tab stops of 4, and the index
// where the content starts. Tabs are only ever expanded for indentation:
// tabs elsewhere in a line are kept verbatim.
function indentOf(line) {
  let col = 0;
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) { col += 4 - (col % 4); i++; }
    else break;
  }
  return { col, idx: i };
}
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}
// Remove `n` columns of leading indentation from a line, consuming a tab
// partially when it straddles the boundary (a tab that covers columns
// [col, col+w) and is cut at `n` leaves w-(n-col) spaces behind).
function stripFenceIndent(line, n) {
  if (n <= 0) return line;
  let i = 0;
  const len = line.length;
  while (i < len && i < n && isWsCh(line[i])) i++;
  return i === 0 ? line : line.slice(i);
}
function stripIndent(line, n) {
  if (n <= 0) return line;
  let col = 0;
  let i = 0;
  const len = line.length;
  while (i < len && col < n) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) {
      const w = 4 - (col % 4);
      if (col + w <= n) { col += w; i++; }
      else {
        // Tab straddles the cut: keep the remaining spaces.
        return ' '.repeat(col + w - n) + line.slice(i + 1);
      }
    } else break;
  }
  return line.slice(i);
}
// Expand the leading whitespace of a line to spaces (tab stops of 4 from
// column 0), used when a line is re-indented relative to a list item.
function expandLeading(line) {
  let col = 0;
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) { col += 4 - (col % 4); i++; }
    else break;
  }
  if (i === 0) return line;
  return ' '.repeat(col) + line.slice(i);
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

// Character classes used by the inline scanner.
// Narrow local part (bare GFM emails, mailto:/xmpp:): alnum + . _ + -
function isEmailLocalCh(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '.' || c === '_' || c === '+' || c === '-';
}
// Broad local part (<...> autolinks): the GFM set minus '^' and ','.
function isAutolinkLocalCh(c) {
  return isEmailLocalCh(c) || c === '!' || c === '#' || c === '$' || c === '%' || c === '&' || c === "'" || c === '*' || c === '/' || c === '=' || c === '?' || c === '`' || c === '{' || c === '|' || c === '}' || c === '~';
}
function isAsciiAlnumCh(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
}
// Code-unit versions of the local-part classes (avoid a 1-char string
// allocation + function call per character in matchEmailAt's scan).
function isEmailLocalCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 95 || c === 43 || c === 45;
}
function isAutolinkLocalCode(c) {
  return isEmailLocalCode(c) || c === 33 || c === 35 || c === 36 || c === 37 || c === 38 || c === 39 || c === 42 || c === 47 || c === 61 || c === 63 || c === 96 || c === 123 || c === 124 || c === 125 || c === 126;
}

// Flanking classification for a delimiter run: prev = char before the run
// ('' at the start of the string), next = char after the run ('' at the end).
// `tildePunct` selects whether '~' counts as punctuation (for the '*' and
// '_' openers and the '*' closer it does not; for the '_' closer it does).
// Returns bit 1 = left-flanking, bit 2 = right-flanking.
function flanking(prev, next, tildePunct) {
  let left = false;
  let right = false;
  if (next !== '' && !isWsCh(next)) {
    if (!isPunctCp(next.codePointAt(0), tildePunct)) left = true;
    else if (prev === '' || isWsCh(prev) || (prev !== '' && isPunctCp(prev.codePointAt(0), tildePunct))) left = true;
  }
  if (prev !== '' && !isWsCh(prev)) {
    if (!isPunctCp(prev.codePointAt(0), tildePunct)) right = true;
    else if (next === '' || isWsCh(next) || (next !== '' && isPunctCp(next.codePointAt(0), tildePunct))) right = true;
  }
  return (left ? 1 : 0) | (right ? 2 : 0);
}
function prevChar(s, i) {
  if (i <= 0) return '';
  const c = s.charCodeAt(i - 1);
  if (c >= 0xDC00 && c <= 0xDFFF && i >= 2) {
    const h = s.charCodeAt(i - 2);
    if (h >= 0xD800 && h <= 0xDBFF) return s.slice(i - 2, i);
  }
  return s[i - 1];
}
function nextChar(s, i, end) {
  if (i >= (end === undefined ? s.length : end)) return '';
  const c = s.charCodeAt(i);
  if (c >= 0xD800 && c <= 0xDBFF && i + 1 < (end === undefined ? s.length : end)) {
    const l = s.charCodeAt(i + 1);
    if (l >= 0xDC00 && l <= 0xDFFF) return s.slice(i, i + 2);
  }
  return s[i];
}

// Match an inline HTML tag at position i (marked's inline tag rule).
// Returns the match length, or 0.
function matchTag(s, i) {
  const n = s.length;
  if (s.charCodeAt(i) !== 60) return 0; // '<'
  if (s.startsWith('<!--', i)) {
    if (s.startsWith('<!-->', i)) return 5;
    if (s.startsWith('<!--->', i)) return 6;
    const end = s.indexOf('-->', i + 4);
    return end === -1 ? 0 : end + 3 - i;
  }
  if (s.charCodeAt(i + 1) === 63) { // '<?'
    const end = s.indexOf('?>', i + 2);
    return end === -1 ? 0 : end + 2 - i;
  }
  if (s.startsWith('<![CDATA[', i)) {
    const end = s.indexOf(']]>', i + 9);
    return end === -1 ? 0 : end + 3 - i;
  }
  if (s.charCodeAt(i + 1) === 33) { // '<!'
    let j = i + 2;
    if (j < n && ((s.charCodeAt(j) >= 65 && s.charCodeAt(j) <= 90) || (s.charCodeAt(j) >= 97 && s.charCodeAt(j) <= 122))) {
      while (j < n && ((s.charCodeAt(j) >= 65 && s.charCodeAt(j) <= 90) || (s.charCodeAt(j) >= 97 && s.charCodeAt(j) <= 122))) j++;
      if (j < n && isSpaceCh(s[j])) {
        const end = s.indexOf('>', j);
        return end === -1 ? 0 : end + 1 - i;
      }
    }
    return 0;
  }
  if (s.charCodeAt(i + 1) === 47) { // '</'
    let j = i + 2;
    if (j >= n || !((s.charCodeAt(j) >= 65 && s.charCodeAt(j) <= 90) || (s.charCodeAt(j) >= 97 && s.charCodeAt(j) <= 122))) return 0;
    while (j < n && ((s.charCodeAt(j) >= 65 && s.charCodeAt(j) <= 90) || (s.charCodeAt(j) >= 97 && s.charCodeAt(j) <= 122) || (s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) || s.charCodeAt(j) === 45)) j++;
    while (j < n && isSpaceCh(s[j])) j++;
    return j < n && s.charCodeAt(j) === 62 ? j + 1 - i : 0;
  }
  // Open tag: <name (attr)* /?>
  let j = i + 1;
  if (j >= n || !((s.charCodeAt(j) >= 65 && s.charCodeAt(j) <= 90) || (s.charCodeAt(j) >= 97 && s.charCodeAt(j) <= 122))) return 0;
  while (j < n && ((s.charCodeAt(j) >= 65 && s.charCodeAt(j) <= 90) || (s.charCodeAt(j) >= 97 && s.charCodeAt(j) <= 122) || (s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) || s.charCodeAt(j) === 45)) j++;
  for (;;) {
    let k = j;
    while (k < n && isSpaceCh(s[k])) k++;
    if (k < n && s.charCodeAt(k) === 62) return k + 1 - i; // '>'
    if (k < n && s.charCodeAt(k) === 47 && s.charCodeAt(k + 1) === 62) return k + 2 - i; // '/>'
    if (k === j) return 0; // no whitespace before something else: not a tag
    j = k;
    // attribute name
    if (j >= n || !((s.charCodeAt(j) >= 65 && s.charCodeAt(j) <= 90) || (s.charCodeAt(j) >= 97 && s.charCodeAt(j) <= 122) || s.charCodeAt(j) === 95 || s.charCodeAt(j) === 58)) return 0;
    j++;
    while (j < n) {
      const c = s.charCodeAt(j);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 58 || c === 46 || c === 45) j++;
      else break;
    }
    let m = j;
    while (m < n && isSpaceCh(s[m])) m++;
    if (m < n && s.charCodeAt(m) === 61) { // '='
      m++;
      while (m < n && isSpaceCh(s[m])) m++;
      if (m < n && (s.charCodeAt(m) === 34 || s.charCodeAt(m) === 39)) {
        const q = s.charCodeAt(m);
        m++;
        while (m < n && s.charCodeAt(m) !== q) m++;
        if (m >= n) return 0;
        m++;
      } else {
        const st = m;
        while (m < n) {
          const c = s.charCodeAt(m);
          if (isSpaceCh(s[m]) || c === 34 || c === 39 || c === 61 || c === 60 || c === 62 || c === 96) break;
          m++;
        }
        if (m === st) return 0;
      }
      j = m;
    }
    // Without a value, j stays at the end of the attribute name so the
    // loop's whitespace skip sees the spaces before the next attribute.
  }
}

// Match an autolink <scheme:...> or <email> at i. Returns {len, email} or null.
function matchAutolink(s, i) {
  const n = s.length;
  if (s.charCodeAt(i) !== 60) return null;
  let j = i + 1;
  // scheme: [a-zA-Z][a-zA-Z0-9+.-]{1,31}:
  if (j < n && ((s.charCodeAt(j) >= 65 && s.charCodeAt(j) <= 90) || (s.charCodeAt(j) >= 97 && s.charCodeAt(j) <= 122))) {
    let k = j + 1;
    while (k < n && ((s.charCodeAt(k) >= 65 && s.charCodeAt(k) <= 90) || (s.charCodeAt(k) >= 97 && s.charCodeAt(k) <= 122) || (s.charCodeAt(k) >= 48 && s.charCodeAt(k) <= 57) || s.charCodeAt(k) === 43 || s.charCodeAt(k) === 46 || s.charCodeAt(k) === 45)) k++;
    if (k - j >= 2 && k - j <= 32 && k < n && s.charCodeAt(k) === 58) {
      let m = k + 1;
      while (m < n) {
        const c = s.charCodeAt(m);
        if (c === 32 || c === 9 || c === 10 || c === 13 || (c >= 0 && c <= 31) || c === 60 || c === 62) break;
        m++;
      }
      if (m < n && s.charCodeAt(m) === 62) return { len: m + 1 - i, email: false };
    }
  }
  // email
  const em = matchEmailAt(s, j, true);
  if (em !== -1 && em < n && s.charCodeAt(em) === 62) return { len: em + 1 - i, email: true };
  return null;
}

// Match an email address at position i (the local part). `strict` selects
// the <autolink> rules (each domain label starts and ends with an alnum
// char and is at most 63 chars); the GFM bare-email rules allow '-'
// anywhere in non-final labels, require only that the final label ends
// with an alnum char, and impose no length cap. Returns the end index
// or -1.
function matchEmailAt(s, i, strict, end) {
  const n = end === undefined ? s.length : end;
  let j = i;
  if (strict) { while (j < n && isAutolinkLocalCode(s.charCodeAt(j))) j++; }
  else { while (j < n && isEmailLocalCode(s.charCodeAt(j))) j++; }
  if (j === i || j >= n || s.charCodeAt(j) !== 64) return -1; // '@'
  j++;
  let labels = 0;
  for (;;) {
    const labelStart = j;
    while (j < n) {
      const c = s.charCodeAt(j);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45) j++;
      else break;
    }
    if (j === labelStart) return -1; // empty label
    if (strict) {
      if (j - labelStart > 63) return -1;
      const first = s.charCodeAt(labelStart);
      const last = s.charCodeAt(j - 1);
      const alnum = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
      if (!alnum(first) || !alnum(last)) return -1;
    }
    labels++;
    if (j < n && s.charCodeAt(j) === 46) { // '.'
      // Only consume the '.' when a label follows it; a trailing '.'
      // ends the address (gfm-632: a.b-c_d@a.b. links a.b-c_d@a.b).
      const nc = j + 1 < n ? s.charCodeAt(j + 1) : -1;
      if (nc !== -1 && ((nc >= 65 && nc <= 90) || (nc >= 97 && nc <= 122) || (nc >= 48 && nc <= 57) || nc === 45)) { j++; continue; }
    }
    break;
  }
  if (labels < 2) return -1; // at least one dot
  if (!strict) {
    // The final label must end with an alnum char.
    const last = s.charCodeAt(j - 1);
    if (!((last >= 65 && last <= 90) || (last >= 97 && last <= 122) || (last >= 48 && last <= 57))) return -1;
    // Guard: the char after the address must not be a word char or '-'.
    if (j < n) {
      const c = s.charCodeAt(j);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 45) return -1;
    }
  }
  return j;
}

// Trim a GFM extended-autolink match the way marked's _backpedal regex
// does: /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|
// [?!.,:;*_'\"~)]+(?!$))+/ applied until it stops changing. The scan is
// left to right: a '(' opens a group that closes at the next ')'
// (an unmatched '(' ends the match there), a run of trailing punctuation
// that reaches the end of the string is dropped except for its last
// character (which a later pass then drops), and an '&' that starts an
// entity at the very end is dropped.
function isBpPunct(c) {
  return c === 63 || c === 33 || c === 46 || c === 44 || c === 58 || c === 59 || c === 42 || c === 95 || c === 39 || c === 34 || c === 126 || c === 41;
}
function backpedalOnce(s) {
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 40) { // '('
      const close = s.indexOf(')', i + 1);
      if (close === -1) break;
      i = close + 1;
    } else if (c === 38) { // '&'
      let j = i + 1;
      while (j < n && isAsciiAlnumCh(s[j])) j++;
      if (j > i + 1 && j < n && s.charCodeAt(j) === 59 && j + 1 === n) break; // &word; at the end
      i++;
    } else if (isBpPunct(c)) {
      let j = i;
      while (j < n && isBpPunct(s.charCodeAt(j))) j++;
      if (j === n) { i = j - 1; break; } // run reaches the end: keep all but its last char
      i = j;
    } else {
      let j = i;
      while (j < n) {
        const d = s.charCodeAt(j);
        if (d === 40 || d === 41 || d === 38 || isBpPunct(d)) break;
        j++;
      }
      i = j;
    }
  }
  return s.slice(0, i);
}
function backpedal(s) {
  let cur = s;
  for (;;) {
    const next = backpedalOnce(cur);
    if (next === cur) return cur;
    cur = next;
  }
}

// Case-insensitive prefix check at position i (no allocation).
function startsWithCi(s, i, lit) {
  for (let k = 0; k < lit.length; k++) {
    const a = s.charCodeAt(i + k);
    const b = lit.charCodeAt(k);
    if (a !== b && a !== b - 32 && a !== b + 32) return false;
  }
  return true;
}

// Try to match a GFM extended autolink at position i. `prev` is the char
// before i ('' at the start). Returns {len, href, text} or null.
function matchExtUrl(s, i, prev, inLink, end) {
  if (inLink) return null;
  const n = end === undefined ? s.length : end;
  // mailto: / xmpp: + email (prev char must not be an ASCII alnum)
  if (i + 5 < n) {
    if (startsWithCi(s, i, 'mailto:') && (i === 0 || !isAsciiAlnumCh(prev))) {
      const emEnd = matchEmailAt(s, i + 7, false, end);
      if (emEnd !== -1) {
        const text = s.slice(i, emEnd);
        return { len: emEnd - i, href: text, text };
      }
    } else if (startsWithCi(s, i, 'xmpp:') && (i === 0 || !isAsciiAlnumCh(prev))) {
      const emEnd = matchEmailAt(s, i + 5, false, end);
      if (emEnd !== -1) {
        let end = emEnd;
        if (end < n && s.charCodeAt(end) === 47) { // xmpp '/...'
          let m = end + 1;
          while (m < n) {
            const c = s.charCodeAt(m);
            if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 64 || c === 46) m++;
            else break;
          }
          if (m > end + 1) end = m;
        }
        const text = s.slice(i, end);
        return { len: end - i, href: text, text };
      }
    }
  }
  // scheme:// or www.
  let prefixLen = 0;
  let isWww = false;
  if (startsWithCi(s, i, 'https://')) prefixLen = 8;
  else if (startsWithCi(s, i, 'http://')) prefixLen = 7;
  else if (startsWithCi(s, i, 'ftp://')) prefixLen = 6;
  else if (s.startsWith('www.', i)) { // case-sensitive: Www./WWW. do not link
    if (i === 0 || prev === '' || isWsCh(prev) || prev === '*' || prev === '_' || prev === '~' || prev === '(') {
      prefixLen = 4;
      isWww = true;
    } else {
      return null;
    }
  }
  if (prefixLen > 0) {
    let j = i + prefixLen;
    // domain: (label.)+ where label = [a-zA-Z0-9-]+ with optional trailing '.'
    let sawLabel = false;
    for (;;) {
      const st = j;
      while (j < n) {
        const c = s.charCodeAt(j);
        if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45) j++;
        else break;
      }
      if (j === st) break;
      sawLabel = true;
      if (j < n && s.charCodeAt(j) === 46) { j++; continue; }
      break;
    }
    if (!sawLabel) return null;
    // The rest of the URL: every character up to whitespace or '<'
    // (marked's [^\s<]*, where \s is JavaScript's \s).
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 60 || isWsCh(s[j])) break;
      j++;
    }
    const text = backpedal(s.slice(i, j));
    if (text.length === 0) return null;
    return { len: text.length, href: isWww ? 'http://' + text : text, text };
  }
  // bare email (only where the text rule would stop: start, or the previous
  // char is not a local-part char)
  if ((i === 0 || !isEmailLocalCh(prev)) && isEmailLocalCh(s[i])) {
    const emEnd = matchEmailAt(s, i, false, end);
    if (emEnd !== -1) {
      const text = s.slice(i, emEnd);
      return { len: emEnd - i, href: 'mailto:' + text, text };
    }
  }
  return null;
}

// Match a nested bracket starting at s[j] === '['. The content is a
// sequence of nested brackets (one more level only: marked's label regex
// allows an outer label, one nested bracket, and one simple pair inside
// it), escapes and plain chars (backticks are plain here); the bracket
// ends at the first ']' that closes this level. Returns the index just
// past the closing ']' or -1.
function matchNestedBracket(s, j, end, depth) {
  let k = j + 1;
  while (k < end) {
    const c = s.charCodeAt(k);
    if (c === 93) return k + 1;
    if (c === 91) {
      if (depth >= 2) return -1;
      const r = matchNestedBracket(s, k, end, depth + 1);
      if (r === -1) return -1;
      k = r;
      continue;
    }
    if (c === 92) { k += 2; continue; }
    k++;
  }
  return -1;
}

// Match label content starting at j. Returns the index of the ']' that
// ends the label or -1. Mirrors marked's label regex with backtracking:
// at a backtick run the code-span alternative (skip to after the next
// backtick run) is tried first; if that path cannot reach a ']', a run of
// 2+ backticks immediately before ']' is consumed as-is. `failed`
// memoises positions that cannot reach a label end (the state is just
// the position, since nested brackets are consumed wholesale).
function matchLabelContent(s, j, end, failed) {
  while (j < end) {
    const c = s.charCodeAt(j);
    if (c === 93) return j; // ']' ends the label
    if (c === 92) { // escape
      if (j + 1 >= end) return -1;
      j += 2;
      continue;
    }
    if (c === 91) { // '[': nested bracket
      const r = matchNestedBracket(s, j, end, 1);
      if (r === -1) return -1;
      j = r;
      continue;
    }
    if (c === 96) { // backtick run
      if (failed.has(j)) return -1;
      let k = j;
      while (k < end && s.charCodeAt(k) === 96) k++;
      // Code-span alternative: the content cannot contain a backtick, so
      // the closing run is the next backtick run; skip past it and try
      // to finish the label from there.
      let m = k;
      while (m < end && s.charCodeAt(m) !== 96) m++;
      if (m < end) {
        let e = m;
        while (e < end && s.charCodeAt(e) === 96) e++;
        const r = matchLabelContent(s, e, end, failed);
        if (r !== -1) return r;
      }
      // Fall back: a run of 2+ backticks immediately before ']' is
      // consumed as-is (doc-33: [less `` a ` b ``](...) must link even
      // when a later backtick exists in the paragraph).
      if (k - j >= 2 && k < end && s.charCodeAt(k) === 93) {
        j = k;
        continue;
      }
      failed.add(j);
      return -1;
    }
    j++;
  }
  return -1;
}

// Find the end of a link label starting at i (s[i] === '['). Returns the
// index of the matching ']' or -1.
function findLabelEnd(s, i, end) {
  return matchLabelContent(s, i + 1, end, new Set());
}

// Find the end of a code span whose opening run of `run` backticks starts
// its content at `from`. Returns the index just past the closing run, or -1.
function findCodeClose(s, from, end, run) {
  let j = from;
  while (j < end) {
    if (s.charCodeAt(j) === 96) {
      let k = j;
      while (k < end && s.charCodeAt(k) === 96) k++;
      // A closing run must be exactly `run` backticks, and the content
      // (s[from..j)) must be non-empty and start/end with a non-backtick
      // (guaranteed by j > from and the runs being maximal).
      if (k - j === run && j > from) return k;
      j = k;
    } else {
      j++;
    }
  }
  return -1;
}

// Parse the "(dest title)" part of an inline link starting at `open`
// (s[open] === '('). Returns {href, title, end} (end = index just past the
// closing ')') or null.
function parseInlineDest(s, open, end) {
  let i = open + 1;
  while (i < end && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9 || s.charCodeAt(i) === 10)) i++;
  if (i >= end) return null;
  let href = '';
  let isAngle = false;
  if (s.charCodeAt(i) === 60) { // '<' angle destination
    let j = i + 1;
    let ok = false;
    while (j < end) {
      const c = s.charCodeAt(j);
      if (c === 92 && j + 1 < end) { j += 2; continue; }
      if (c === 10 || c === 60) break;
      if (c === 62) { ok = true; break; }
      j++;
    }
    // A destination starting with '<' must be a valid angle destination;
    // there is no fallback to a bare destination (cm-493, cm-494).
    if (!ok) return null;
    // The closing '>' must not be escaped (odd backslashes before it).
    let b = 0;
    for (let k = j - 1; k > i && s.charCodeAt(k) === 92; k--) b++;
    if (b % 2 === 1) return null;
    href = s.slice(i + 1, j);
    isAngle = true;
    i = j + 1;
  }
  if (!isAngle) {
    // Bare destination: no spaces, tabs, newlines or control chars. It may
    // contain parens; unbalanced ones are handled below.
    let j = i;
    while (j < end) {
      const c = s.charCodeAt(j);
      if (c === 32 || c === 9 || c === 10 || (c >= 0 && c <= 31)) break;
      j++;
    }
    if (j === i) {
      // Empty destination, allowed only when ')' follows immediately.
      if (i < end && s.charCodeAt(i) === 41) {
        return { href: '', title: null, end: i + 1 };
      }
      return null;
    }
    let dest = s.slice(i, j);
    // Paren balance (ke): -2 = unclosed '(' (fail), >=0 = extra ')' index.
    let depth = 0;
    let extra = -1;
    for (let k = 0; k < dest.length; k++) {
      const c = dest.charCodeAt(k);
      if (c === 92) { k++; continue; }
      if (c === 40) depth++;
      else if (c === 41) {
        depth--;
        if (depth < 0) { extra = k; break; }
      }
    }
    if (extra === -1 && depth > 0) return null;
    if (extra >= 0) {
      // The link ends at the extra ')'.
      const closePos = i + extra;
      // The closing ')' must not be escaped.
      let b = 0;
      for (let k = closePos - 1; k >= i && s.charCodeAt(k) === 92; k--) b++;
      if (b % 2 === 1) return null;
      return { href: dest.slice(0, extra), title: null, end: closePos + 1 };
    }
    href = dest;
    i = j;
  }
  // Optional title after spaces/newlines.
  let title = null;
  let save = i;
  let k = i;
  while (k < end && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9 || s.charCodeAt(k) === 10)) k++;
  if (k < end) {
    const q = s.charCodeAt(k);
    if (q === 34 || q === 39 || q === 40) {
      const closeQ = q === 40 ? 41 : q;
      let m = k + 1;
      let ok = false;
      while (m < end) {
        const c = s.charCodeAt(m);
        if (c === 92 && m + 1 < end) { m += 2; continue; }
        if (c === closeQ) { ok = true; break; }
        if (q === 39 && c === 10 && m + 1 < end && s.charCodeAt(m + 1) === 10) break;
        m++;
      }
      if (ok) {
        title = s.slice(k + 1, m);
        i = m + 1;
      } else {
        i = save;
      }
    }
  }
  while (i < end && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9 || s.charCodeAt(i) === 10)) i++;
  if (i >= end || s.charCodeAt(i) !== 41) return null;
  // The closing ')' must not be escaped.
  let b = 0;
  for (let kk = i - 1; kk >= open && s.charCodeAt(kk) === 92; kk--) b++;
  if (b % 2 === 1) return null;
  return { href, title, end: i + 1 };
}

// marked's Be check: a link label must not contain a '<' that starts an
// HTML tag or autolink reaching past the label's end.
function labelHasOpenTag(s, labelStart, labelEnd) {
  for (let p = labelStart; p < labelEnd; p++) {
    const c = s.charCodeAt(p);
    if (c === 92) { p++; continue; }
    if (c === 96) {
      let k = p;
      while (k < labelEnd && s.charCodeAt(k) === 96) k++;
      const close = findCodeClose(s, k, labelEnd, k - p);
      if (close !== -1) { p = close - 1; continue; }
      p = k - 1;
      continue;
    }
    if (c !== 60) continue; // '<'
    const tl = matchTag(s, p);
    if (tl > 0 && p + tl > labelEnd) return true;
    const al = matchAutolink(s, p);
    if (al && p + al.len > labelEnd) return true;
  }
  return false;
}

// Try to parse a link or image starting at position i of s (s[i] is '['
// or '!' followed by '['). Returns {html, end, isLink} or null. `cx` is
// the inline context; `isImage` is set by the caller.
function tryLink(s, i, end, cx, isImage) {
  const labelStart = isImage ? i + 2 : i + 1;
  const close = findLabelEnd(s, isImage ? i + 1 : i, end);
  if (close === -1) return null;
  const labelRaw = s.slice(labelStart, close);
  let href = null;
  let title = null;
  let after = close + 1;
  if (after < end && s.charCodeAt(after) === 40) { // '(' inline link
    const parsed = parseInlineDest(s, after, end);
    if (parsed) {
      href = unescapePunct(parsed.href);
      title = parsed.title === null ? null : unescapePunct(parsed.title);
      after = parsed.end;
    } else {
      // An inline link that fails falls back to a shortcut reference
      // link for the same label (cm-568: [foo](not a link) with a def
      // for foo links foo and leaves "(not a link)" as text).
      const key = normalizeLabel(labelRaw);
      const def = cx.refs.get(key);
      if (!def) return null;
      href = def.href;
      title = def.title;
    }
  } else if (after < end && s.charCodeAt(after) === 91) { // '[' reference
    const refClose = s.indexOf(']', after + 1);
    if (refClose === -1) return null;
    const refRaw = s.slice(after + 1, refClose);
    // The reference label must not contain an unescaped '[' or ']' or a
    // blank line (the le rule); escaped brackets are allowed (cm-549).
    let badRef = false;
    for (let p = 0; p < refRaw.length; p++) {
      const cc = refRaw.charCodeAt(p);
      if (cc === 92) { p++; continue; }
      if (cc === 91 || cc === 93) { badRef = true; break; }
    }
    if (badRef) return null;
    if (/\n[ \t]*\n/.test(refRaw)) return null;
    const key = normalizeLabel(refRaw === '' ? labelRaw : refRaw);
    const def = cx.refs.get(key);
    if (!def) return null;
    href = def.href;
    title = def.title;
    after = refClose + 1;
  } else {
    // Shortcut reference.
    const key = normalizeLabel(labelRaw);
    const def = cx.refs.get(key);
    if (!def) return null;
    href = def.href;
    title = def.title;
  }
  // The label must not contain an unclosed '<...>' reaching past its end.
  if (labelRaw.indexOf('<') !== -1 && labelHasOpenTag(s, labelStart, close)) return null;
  // Link text may not contain a link (images may). The label is parsed
  // with a fresh context (inLink on, hasLink fresh); an inRawBlock change
  // inside the label persists, as in marked's shared lexer state. An
  // image label is parsed in plain mode, and plain mode is inherited by
  // nested links/images inside it (their alt text is plain text).
  const childCx = { refs: cx.refs, plain: cx.plain || isImage, inLink: true, inRaw: cx.inRaw, hasLink: false };
  const labelText = scanInline(s, labelStart, close, childCx);
  cx.inRaw = childCx.inRaw;
  if (!isImage && childCx.hasLink) return null;
  if (cx.plain) {
    // Inside an image alt, a link or image renders as its plain label
    // text (cm-520, cm-573-577, cm-585, cm-589).
    if (!isImage) cx.hasLink = true;
    return { html: labelText, end: after, isLink: !isImage };
  }
  if (isImage) {
    const alt = escText(labelText);
    const clean = cleanUrl(href);
    if (clean === null) return { html: alt, end: after, isLink: false };
    return {
      html: `<img src="${escText(clean)}" alt="${alt}"${title !== null ? ` title="${escText(title)}"` : ''}>`,
      end: after, isLink: false,
    };
  }
  cx.hasLink = true;
  const clean = cleanUrl(href);
  if (clean === null) return { html: labelText, end: after, isLink: true };
  return {
    html: `<a href="${escText(clean)}"${title !== null ? ` title="${escText(title)}"` : ''}>${labelText}</a>`,
    end: after, isLink: true,
  };
}

// Whether a single char is punctuation-or-whitespace (marked's
// "punctuation" rule: [\s\p{P}\p{S}], where '~' counts as punctuation).
function isPunctOrSpace(ch) {
  return ch !== '' && (isWsCh(ch) || isPunctCp(ch.codePointAt(0), true));
}

// Classify a delimiter run at j (prev/next are the chars around the run)
// for the closer scan: 'opener' (left-flanking only), 'closer'
// (right-flanking only), 'both', or 'none' (not a candidate at all).
// For '_', a both-flanking run with word characters on both sides is not
// a candidate (marked's '_' closer regex has no such group).
function classifyDelim(delim, prev, next, tildePunct) {
  const fl = flanking(prev, next, tildePunct);
  const left = (fl & 1) !== 0;
  const right = (fl & 2) !== 0;
  if (left && !right) return 'opener';
  if (right && !left) return 'closer';
  if (left && right) {
    if (delim === '_') {
      const pp = prev !== '' && isPunctCp(prev.codePointAt(0), true);
      const np = next !== '' && isPunctCp(next.codePointAt(0), true);
      return pp && np ? 'both' : 'none';
    }
    return 'both';
  }
  return 'none';
}

// Skip the opaque token starting at j (escape, code span, link, html tag,
// autolink), if any. Returns the position just past it, or j.
function skipOpaque(s, j, end, cx) {
  const c = s.charCodeAt(j);
  if (c === 92) { // backslash escape or hard break
    if (j + 1 < end && isAsciiPunct(s[j + 1])) return j + 2;
    if (j + 1 < end && s.charCodeAt(j + 1) === 10) {
      let k = j + 2;
      while (k < end && (s[k] === ' ' || s[k] === '\t')) k++;
      return k;
    }
    return j;
  }
  if (c === 96) { // code span
    let run = 0;
    while (j + run < end && s.charCodeAt(j + run) === 96) run++;
    const close = findCodeClose(s, j + run, end, run);
    // A failed code span's whole backtick run is literal text (marked's
    // masking regex consumes it as `+), so skip past it rather than
    // letting the second backtick open a shorter span (doc-01).
    return close === -1 ? j + run : close;
  }
  if (c === 91 || (c === 33 && j + 1 < end && s.charCodeAt(j + 1) === 91)) {
    const link = tryLink(s, j, end, cx, c === 33);
    return link ? link.end : j;
  }
  if (c === 60) { // html tag or autolink
    const tl = matchTag(s, j);
    if (tl > 0) return j + tl;
    const al = matchAutolink(s, j);
    if (al) return j + al.len;
    return j;
  }
  return j;
}

// --- Inline masking (the emphasis closer scan's view) -------------------
// The emphasis closer scan runs on a masked copy of the inline string in
// which code spans, link/image labels and HTML tags are replaced by
// placeholder characters, so delimiters inside those constructs are
// invisible to the scan. The mask is length-preserving, so positions in
// the mask and in the real string are the same. Three passes, in order:
// (1) reference-link matches are masked to 'a's when the ref is defined
// (only when refs exist); (2) code spans, bare backtick runs and escapes
// are normalised (escapes become '++', inner backticks of a code span
// become '+'); (3) link/image, code-span and HTML matches are masked to
// '[aaa...]'.

// Step 2: mask code spans, bare backtick runs and escapes. A code span
// is an opening backtick run, content that does not start or end with a
// backtick, and a closing run of exactly the same length; its inner
// backticks become '+', the runs themselves are kept. A bare run is left
// unchanged. An escape (\ + a Unicode punctuation/symbol) becomes '++'.
// Only the changed ranges are materialised; an unchanged string is
// returned as-is.
function maskCodeAndEscapes(t) {
  const n = t.length;
  let out = '';
  let seg = 0;
  let j = 0;
  while (j < n) {
    const c = t.charCodeAt(j);
    if (c === 96) {
      let k = j;
      while (k < n && t.charCodeAt(k) === 96) k++;
      const L = k - j;
      let m = k;
      let close = -1;
      while (m < n) {
        m = t.indexOf('`', m);
        if (m === -1) break;
        let e = m;
        while (e < n && t.charCodeAt(e) === 96) e++;
        if (e - m === L) { close = m; break; }
        m = e;
      }
      if (close !== -1) {
        // Does the content contain a backtick to replace?
        const inner = t.indexOf('`', k);
        if (inner !== -1 && inner < close) {
          out += t.slice(seg, j);
          out += t.slice(j, k);
          out += t.slice(k, close).replaceAll('`', '+');
          out += t.slice(close, close + L);
          j = close + L;
          seg = j;
        } else {
          j = close + L;
        }
      } else {
        j = k;
      }
      continue;
    }
    if (c === 92 && j + 1 < n) {
      const cp = t.codePointAt(j + 1);
      if ((clsOf(cp) & 1) !== 0) {
        const w = cp > 0xFFFF ? 2 : 1;
        out += t.slice(seg, j);
        for (let q = 0; q < 1 + w; q++) out += '+';
        j += 1 + w;
        seg = j;
        continue;
      }
    }
    j++;
  }
  if (seg === 0) return t;
  return out + t.slice(seg);
}

// Match a blockSkip dest starting at t[j] === '('. The dest is a sequence
// of escapes, plain chars or one level of parenthesised groups, then ')'.
// Returns the index just past the closing ')' or -1.
function matchBlockSkipDest(t, j, n) {
  let k = j + 1;
  while (k < n) {
    const c = t.charCodeAt(k);
    if (c === 92) { k += 2; continue; }
    if (c === 40) {
      let m = k + 1;
      let ok = false;
      while (m < n) {
        const d = t.charCodeAt(m);
        if (d === 92) { m += 2; continue; }
        if (d === 40) break;
        if (d === 41) { ok = true; break; }
        m++;
      }
      if (!ok) return -1;
      k = m + 1;
      continue;
    }
    if (c === 41) return k + 1;
    k++;
  }
  return -1;
}

// Match a blockSkip link starting at t[j] === '['. The label is a sequence
// of plain chars (not '[', ']' or backtick) or code spans (opening run,
// backtick-free content, closing run of the same length); the dest follows
// in parens. Returns the index just past the closing ')' or -1.
function matchBlockSkipLink(t, j, n) {
  let k = j + 1;
  while (k < n) {
    const c = t.charCodeAt(k);
    if (c === 93) {
      if (k + 1 < n && t.charCodeAt(k + 1) === 40) {
        const dEnd = matchBlockSkipDest(t, k + 1, n);
        if (dEnd !== -1) return dEnd;
      }
      return -1;
    }
    if (c === 91) return -1;
    if (c === 96) {
      let m = k;
      while (m < n && t.charCodeAt(m) === 96) m++;
      const L = m - k;
      const p = t.indexOf('`', m);
      if (p === -1) return -1;
      let e = p;
      while (e < n && t.charCodeAt(e) === 96) e++;
      if (e - p !== L) return -1;
      k = e;
      continue;
    }
    k++;
  }
  return -1;
}

// Step 3: mask link/image, code-span and HTML matches to '[aaa...]'.
// A link is [label](dest) as matched by matchBlockSkipLink; a code span
// is an opening run, backtick-free content and a closing run of the same
// length; an HTML tag is '<' (not followed by a space) up to the first
// '>' with no '<' in between. Only the changed ranges are materialised.
function maskBlockSkip(t) {
  const n = t.length;
  let out = '';
  let seg = 0;
  let j = 0;
  while (j < n) {
    const c = t.charCodeAt(j);
    if (c === 91) {
      const end = matchBlockSkipLink(t, j, n);
      if (end !== -1) {
        out += t.slice(seg, j);
        out += '[' + 'a'.repeat(end - j - 2) + ']';
        j = end;
        seg = j;
        continue;
      }
      j++;
      continue;
    }
    if (c === 96) {
      // A code span must not be preceded by a backtick (the precode in
      // marked's blockSkip: (?<!`) or (^|[^`])). Without this, a `` `` ``
      // run would be split and the second backtick would wrongly start
      // a code span (doc-01: **faster will ``pull` note** ...).
      let k = j;
      while (k < n && t.charCodeAt(k) === 96) k++;
      const L = k - j;
      let close = -1;
      if (j === 0 || t.charCodeAt(j - 1) !== 96) {
        const m = t.indexOf('`', k);
        if (m !== -1) {
          let e = m;
          while (e < n && t.charCodeAt(e) === 96) e++;
          if (e - m === L) close = m;
        }
      }
      if (close !== -1) {
        out += t.slice(seg, j);
        out += '[' + 'a'.repeat(close + L - j - 2) + ']';
        j = close + L;
        seg = j;
        continue;
      }
      j++;
      continue;
    }
    if (c === 60) {
      if (j + 1 < n && t.charCodeAt(j + 1) !== 32) {
        const gt = t.indexOf('>', j + 1);
        const lt = t.indexOf('<', j + 1);
        const m = gt !== -1 && (lt === -1 || gt < lt) ? gt : lt;
        if (m !== -1 && t.charCodeAt(m) === 62) {
          out += t.slice(seg, j);
          out += '[' + 'a'.repeat(m - j - 1) + ']';
          j = m + 1;
          seg = j;
          continue;
        }
      }
      j++;
      continue;
    }
    j++;
  }
  if (seg === 0) return t;
  return out + t.slice(seg);
}

// Find a reference-link (reflink or nolink) match starting at t[j]
// ('[' or '!['). Returns {end, refText, isReflink, labelText} or null.
// The label is found with findLabelEnd; the ref is a run of escapes or
// chars that are not '[', ']' or backslash, ending at the first ']' (it
// must not be empty or all whitespace). A nolink must not be followed by
// '(' (that would be an inline link).
function matchReflinkAt(t, j, n) {
  const bang = t.charCodeAt(j) === 33;
  const bracket = bang ? j + 1 : j;
  if (bracket >= n || t.charCodeAt(bracket) !== 91) return null;
  const labelEnd = findLabelEnd(t, bracket, n);
  if (labelEnd === -1) return null;
  const labelText = t.slice(bracket + 1, labelEnd);
  if (labelEnd + 1 < n && t.charCodeAt(labelEnd + 1) === 91) {
    // Reflink: [label][ref].
    let k = labelEnd + 2;
    let refEnd = -1;
    while (k < n) {
      const c = t.charCodeAt(k);
      if (c === 92) { k += 2; continue; }
      if (c === 91 || c === 93) { if (c === 93) refEnd = k; break; }
      k++;
    }
    if (refEnd === -1) return null;
    const refText = t.slice(labelEnd + 2, refEnd);
    if (refText === '' || /^\s*$/.test(refText)) return null;
    return { end: refEnd + 1, refText, isReflink: true, labelText, bang };
  }
  // Nolink: [ref] (must not be followed by '(').
  if (labelEnd + 1 < n && t.charCodeAt(labelEnd + 1) === 40) return null;
  if (labelText === '' || /^\s*$/.test(labelText)) return null;
  return { end: labelEnd + 1, refText: labelText, isReflink: false, labelText, bang };
}

// Does the text contain a link (an inline link or a defined reference
// link)? Used by the reflink masking to decide whether a reference-link
// label is masked wholesale or recursively.
function labelHasLink(text, refs) {
  if (text.indexOf('[') === -1) return false;
  const n = text.length;
  let j = 0;
  while (j < n) {
    if (text.charCodeAt(j) === 91) {
      if (matchBlockSkipLink(text, j, n) !== -1) return true;
      const m = matchReflinkAt(text, j, n);
      if (m && refs.has(normalizeLabel(m.refText))) return true;
    }
    j++;
  }
  return false;
}

// Step 1: mask reference-link matches to 'a's when the ref is defined.
// A reflink whose label contains a link is masked recursively (the label
// keeps its structure, only the ref part becomes 'a's); anything else
// defined becomes '[aaa...]'. Only the changed ranges are materialised.
function maskReflinks(t, refs) {
  const n = t.length;
  let out = '';
  let seg = 0;
  let j = 0;
  while (j < n) {
    const c = t.charCodeAt(j);
    if (c === 91 || (c === 33 && j + 1 < n && t.charCodeAt(j + 1) === 91)) {
      const m = matchReflinkAt(t, j, n);
      if (m) {
        const matchLen = m.end - j;
        if (refs.has(normalizeLabel(m.refText))) {
          out += t.slice(seg, j);
          if (m.isReflink && !m.bang && m.labelText !== '' && labelHasLink(m.labelText, refs)) {
            // Recursively mask the label; mask the ref part to 'a's.
            const maskedLabel = maskReflinks(m.labelText, refs);
            out += '[' + maskedLabel + '][' + 'a'.repeat(matchLen - m.labelText.length - 4) + ']';
          } else {
            out += '[' + 'a'.repeat(matchLen - 2) + ']';
          }
          j = m.end;
          seg = j;
          continue;
        }
        // Ref not defined: leave the match unchanged.
        j = m.end;
        continue;
      }
    }
    j++;
  }
  if (seg === 0) return t;
  return out + t.slice(seg);
}

// Compute the inline mask for the slice s[start..end]. Returns the masked
// string (same length as the slice), or null when the slice needs no
// masking (no backtick, '[', '<' or backslash to hide) -- the caller then
// uses the real string with the slice bounds for clamping, so no slice is
// allocated. When a masked string is returned it is exactly the slice, so
// the flanking characters around a delimiter are read within the slice
// only -- a character just past the slice end (e.g. the closing ~~ of a
// del span) must not be seen.
function computeMask(s, start, end, refs) {
  // Check on the real string first (no slice allocation): is there
  // anything that could hide a delimiter?
  let hasMaskable = false;
  let p = s.indexOf('`', start);
  if (p !== -1 && p < end) hasMaskable = true;
  else {
    p = s.indexOf('[', start);
    if (p !== -1 && p < end) hasMaskable = true;
    else {
      p = s.indexOf('<', start);
      if (p !== -1 && p < end) hasMaskable = true;
      else {
        p = s.indexOf('\\', start);
        if (p !== -1 && p < end) hasMaskable = true;
      }
    }
  }
  if (!hasMaskable) return null;
  const slice = s.slice(start, end);
  let t = slice;
  if (refs.size > 0 && t.indexOf('[') !== -1) t = maskReflinks(t, refs);
  // Each pass only runs when its trigger characters are present: a slice
  // with only '[' skips the code/escape scan, one with only '\' skips
  // the link/code/HTML scan (indexOf is C-speed, the passes are not).
  if (t.indexOf('`') !== -1 || t.indexOf('\\') !== -1) t = maskCodeAndEscapes(t);
  if (t.indexOf('`') !== -1 || t.indexOf('[') !== -1 || t.indexOf('<') !== -1) t = maskBlockSkip(t);
  return t;
}

// The character ending just before mask index `idx` (a code point string,
// handling surrogate pairs), or '' at the start bound `lo` (the mask
// index of the first character of the slice).
function maskPrevChar(mask, idx, lo) {
  if (idx <= lo) return '';
  const c = mask.charCodeAt(idx - 1);
  if (c >= 0xDC00 && c <= 0xDFFF && idx - 2 >= lo) {
    const hi = mask.charCodeAt(idx - 2);
    if (hi >= 0xD800 && hi <= 0xDBFF) return mask.slice(idx - 2, idx);
  }
  return mask[idx - 1];
}

// The character starting at mask index `idx` (a code point string), or ''
// at the end bound `hi` (the mask index just past the slice end).
function maskNextChar(mask, idx, hi) {
  if (idx >= hi) return '';
  const c = mask.charCodeAt(idx);
  if (c >= 0xD800 && c <= 0xDBFF && idx + 1 < hi) {
    const lo = mask.charCodeAt(idx + 1);
    if (lo >= 0xDC00 && lo <= 0xDFFF) return mask.slice(idx, idx + 2);
  }
  return mask[idx];
}

// Try to match an emphasis/strong span starting at i (s[i] is '*' or '_').
// `r` is the last character of the previous text token ('' at the start).
// Returns {html, end} or null.
// The RDelim regex's masking alternative: a delimiter run inside the
// opposite delimiter's strong span is not a candidate, but only when the
// pattern starts at the scan position (the regex is ^-anchored, so this
// applies once, at the start of the scan). For '*', the pattern is
// [^*_]*? __ [^*_]*? * [^*_]*? (?=__); for '_', the same with '**' and
// '_'. Returns the position just past the masked run, or -1.
function maskedRunEnd(s, from, end, delim) {
  const other = delim === '*' ? '_' : '*';
  let j = from;
  while (j < end && s[j] !== '*' && s[j] !== '_') j++;
  if (j + 1 >= end || s[j] !== other || s[j + 1] !== other) return -1;
  j += 2;
  while (j < end && s[j] !== '*' && s[j] !== '_') j++;
  if (j >= end || s[j] !== delim) return -1;
  let k = j;
  while (k < end && s[k] === delim) k++;
  let m = k;
  while (m < end && s[m] !== '*' && s[m] !== '_') m++;
  if (m + 1 >= end || s[m] !== other || s[m + 1] !== other) return -1;
  return k;
}

function findEm(s, i, end, cx, r, mask, mOff, sStart) {
  const delim = s[i];
  const lo = sStart - mOff;
  const hi = end - mOff;
  let k = 0;
  while (i + k < end && s[i + k] === delim) k++;
  const next = nextChar(s, i + k, end);
  if (next === '' || isWsCh(next)) return null;
  let l = i;
  while (l > sStart && mask[l - mOff - 1] === delim) l--;
  // The char before the opener run comes from the MASKED string (marked's
  // emStrong reads it from the mask, not the real string).
  const p = maskPrevChar(mask, l - mOff, lo);
  const n = l < i ? p : r;
  const o = r === delim;
  const h = isPunctOrSpace(p) || p === '*' || p === '_';
  const u = l < i ? h : isPunctOrSpace(n);
  // d: the punctuation character after the opener run ('~' is not
  // punctuation here), or '' when the next char is not punctuation.
  const d = next !== '' && isPunctCp(next.codePointAt(0), false) ? next : '';
  if (d !== '' && n !== '' && !u) return null;
  if (delim === '_' && d === '' && n !== '' && isAlnumCp(n.codePointAt(0))) return null;
  const y = i - l + k;
  const pNonWs = p !== '' && !isWsCh(p);
  const R = pNonWs && (d !== '' || (delim === '*' && !isPunctOrSpace(p)));
  const tildePunct = delim === '_';
  let m = k;
  let f = 0;
  let j = i + k;
  // Mask a delimiter run inside the opposite strong span at the start of
  // the scan (cm-470: the * inside __bar *baz bim__ is not a candidate).
  // This runs on the MASKED string.
  const masked = maskedRunEnd(mask, j - mOff, end - mOff, delim);
  if (masked !== -1) j = masked + mOff;
  // The closer scan runs on the MASKED string: code spans, links and HTML
  // are already hidden there, so no skipOpaque is needed and a delimiter
  // inside a failed link label or a phantom code span is never seen.
  // Jump to the next delimiter run with indexOf instead of stepping
  // through the mask one character at a time.
  while (j < end) {
    const nj = mask.indexOf(delim, j - mOff);
    if (nj === -1 || nj >= end - mOff) break;
    j = nj + mOff;
    let rlen = 0;
    while (j + rlen < end && mask[j + rlen - mOff] === delim) rlen++;
    const p2 = maskPrevChar(mask, j - mOff, lo);
    const n2 = maskNextChar(mask, j + rlen - mOff, hi);
    const kind = classifyDelim(delim, p2, n2, tildePunct);
    if (kind === 'none') { j += rlen; continue; }
    if (kind === 'opener') { m += rlen; j += rlen; continue; }
    if (kind === 'both' || R) {
      if (o && kind === 'both') return null;
      if (y % 3 !== 0 && (y + rlen) % 3 === 0) { f += rlen; j += rlen; continue; }
    }
    m -= rlen;
    if (m > 0) { j += rlen; continue; }
    const b = Math.min(rlen, rlen + m + f);
    const rawEnd = j + b;
    if (Math.min(k, b) % 2 === 1) {
      const inner = scanInline(s, i + 1, rawEnd - 1, cx);
      return { html: cx.plain ? inner : '<em>' + inner + '</em>', end: rawEnd };
    }
    const inner = scanInline(s, i + 2, rawEnd - 2, cx);
    return { html: cx.plain ? inner : '<strong>' + inner + '</strong>', end: rawEnd };
  }
  return null;
}

// Try to match a strikethrough span starting at i (s[i] is '~').
// `r` is the last character of the previous text token.
function findDel(s, i, end, cx, r, mask, mOff, sStart) {
  const lo = sStart - mOff;
  const hi = end - mOff;
  let k = 0;
  while (i + k < end && s[i + k] === '~') k++;
  if (k === 0 || k > 2) return null;
  const next = nextChar(s, i + k, end);
  if (next === '' || isWsCh(next) || next === '~') return null;
  const n = r;
  const d = next !== '' && isPunctCp(next.codePointAt(0), true) ? next : '';
  if (d !== '' && n !== '' && !isPunctOrSpace(n)) return null;
  let p = k;
  let j = i + k;
  // The closer scan runs on the MASKED string (see findEm); jump to the
  // next '~' run with indexOf instead of stepping one char at a time.
  while (j < end) {
    const nj = mask.indexOf('~', j - mOff);
    if (nj === -1 || nj >= end - mOff) break;
    j = nj + mOff;
    let rlen = 0;
    while (j + rlen < end && mask[j + rlen - mOff] === '~') rlen++;
    if (rlen !== k) { j += rlen; continue; }
    const p2 = maskPrevChar(mask, j - mOff, lo);
    const n2 = maskNextChar(mask, j + rlen - mOff, hi);
    const kind = classifyDelim('~', p2, n2, true);
    if (kind === 'none') { j += rlen; continue; }
    if (kind === 'opener') { p += rlen; j += rlen; continue; }
    p -= rlen;
    if (p > 0) { j += rlen; continue; }
    const l = Math.min(rlen, rlen + p);
    const rawEnd = j + l;
    const inner = scanInline(s, i + k, rawEnd - k, cx);
    return { html: cx.plain ? inner : '<del>' + inner + '</del>', end: rawEnd };
  }
  return null;
}

// Update the inLink / inRawBlock state for an inline HTML tag.
function updateTagState(tag, cx) {
  const c1 = tag.charCodeAt(1);
  if (!cx.inLink && (c1 === 97 || c1 === 65) && tag.charCodeAt(2) === 32) cx.inLink = true;
  else if (cx.inLink && c1 === 47 && (tag.charCodeAt(2) === 97 || tag.charCodeAt(2) === 65) && tag.charCodeAt(3) === 62) cx.inLink = false;
  let j = 1;
  if (c1 === 47) j = 2;
  let nameEnd = j;
  while (nameEnd < tag.length) {
    const cc = tag.charCodeAt(nameEnd);
    if ((cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122)) nameEnd++;
    else break;
  }
  const name = tag.slice(j, nameEnd).toLowerCase();
  if (name === 'pre' || name === 'code' || name === 'kbd' || name === 'script') {
    const after = tag.charCodeAt(nameEnd);
    if (after === 62 || isSpaceCh(tag[nameEnd])) {
      if (c1 === 47) { if (cx.inRaw) cx.inRaw = false; }
      else if (!cx.inRaw) cx.inRaw = true;
    }
  }
}

// Render one inline string (a paragraph's text, a heading's text, a table
// cell, a link label, an emphasis run, ...). `cx` carries the shared
// inline state: refs, plain (text-only rendering for image alt text),
// inLink, inRaw, hasLink.
function scanInline(s, start, end, cx) {
  const out = [];
  let i = start;
  let seg = start;
  let r = '';
  // Mask for the emphasis closer scan, computed lazily on first use (see
  // computeMask). When masking is needed, `mask` is the masked slice and
  // `maskOff` is the slice start; when it is not, `mask` is the real
  // string and `maskOff` is 0, and findEm/findDel clamp reads to the
  // slice [start, end) via the sStart parameter. Either way the mask
  // character at absolute position p is mask[p - maskOff]. Each scanInline
  // call has its own mask; recursive calls for labels and emphasis
  // content compute their own.
  let mask = null;
  let maskOff = 0;
  // Whether this slice contains an '@' (-1 = unknown, computed lazily):
  // the bare-email path of matchExtUrl needs one, so slices without it
  // skip matchExtUrl entirely when no scheme can match either.
  let hasAt = -1;
  const ensureMask = () => {
    if (mask === null) {
      const m = computeMask(s, start, end, cx.refs);
      if (m === null) { mask = s; maskOff = 0; }
      else { mask = m; maskOff = start; }
    }
  };
  // The effective last text character: the last character of the
  // unflushed text segment (if any), else the last flushed one. A
  // trailing '_' does not update it (marked's rule).
  const effR = () => {
    if (i > seg) {
      const last = s[i - 1];
      if (last !== '_') {
        const lc = s.charCodeAt(i - 1);
        if (lc >= 0xDC00 && lc <= 0xDFFF && i - 1 > seg) {
          const hc = s.charCodeAt(i - 2);
          if (hc >= 0xD800 && hc <= 0xDBFF) return s.slice(i - 2, i);
        }
        return last;
      }
    }
    return r;
  };
  const flush = (to) => {
    if (to > seg) {
      const raw = s.slice(seg, to);
      out.push(cx.plain ? (cx.inRaw ? raw : decodeNumeric(raw)) : (cx.inRaw ? raw : escText(raw)));
      const last = raw[raw.length - 1];
      if (last !== '_') {
        const lc = raw.charCodeAt(raw.length - 1);
        if (lc >= 0xDC00 && lc <= 0xDFFF && raw.length >= 2) {
          const hc = raw.charCodeAt(raw.length - 2);
          r = hc >= 0xD800 && hc <= 0xDBFF ? raw.slice(-2) : last;
        } else {
          r = last;
        }
      }
    }
  };
  const pushChunk = (t) => {
    out.push(cx.plain ? (cx.inRaw ? t : decodeNumeric(t)) : (cx.inRaw ? t : escText(t)));
  };
  while (i < end) {
    const c = s.charCodeAt(i);
    if (c === 92) { // backslash
      const nx = i + 1 < end ? s[i + 1] : '';
      if (nx !== '' && isAsciiPunct(nx)) {
        flush(i);
        pushChunk(nx);
        i += 2;
        seg = i;
        r = '';
        continue;
      }
      if (nx === '\n') {
        let hasContent = false;
        for (let m = i + 2; m < end; m++) { if (!isSpaceCh(s[m])) { hasContent = true; break; } }
        if (hasContent) {
          flush(i);
          if (!cx.plain) out.push('<br>');
          i += 2;
          while (i < end && (s[i] === ' ' || s[i] === '\t')) i++;
          seg = i;
          r = '';
          continue;
        }
      }
      i++;
      continue;
    }
    if (c === 10) { // newline: hard break after 2+ spaces
      let t = i;
      while (t > seg && s.charCodeAt(t - 1) === 32) t--;
      if (i - t >= 2) {
        let hasContent = false;
        for (let m = i + 1; m < end; m++) { if (!isSpaceCh(s[m])) { hasContent = true; break; } }
        if (hasContent) {
          flush(t);
          if (!cx.plain) out.push('<br>');
          i++;
          while (i < end && (s[i] === ' ' || s[i] === '\t')) i++;
          seg = i;
          r = '';
          continue;
        }
      }
      i++;
      continue;
    }
    if (c === 60) { // '<': html tag or autolink
      const tl = matchTag(s, i);
      if (tl > 0) {
        flush(i);
        const tag = s.slice(i, i + tl);
        out.push(tag);
        updateTagState(tag, cx);
        i += tl;
        seg = i;
        r = '';
        continue;
      }
      const al = matchAutolink(s, i);
      if (al) {
        flush(i);
        const text = s.slice(i + 1, i + al.len - 1);
        if (cx.plain) {
          out.push(text);
        } else {
          const href = al.email ? 'mailto:' + text : text;
          const clean = cleanUrl(href);
          if (clean === null) out.push(escEncode(text));
          else out.push(`<a href="${escEncode(clean)}">${escEncode(text)}</a>`);
        }
        i += al.len;
        seg = i;
        r = '';
        continue;
      }
      i++;
      continue;
    }
    if (c === 91 || (c === 33 && i + 1 < end && s.charCodeAt(i + 1) === 91)) { // '[' or '!['
      const link = tryLink(s, i, end, cx, c === 33);
      if (link) {
        flush(i);
        out.push(link.html);
        i = link.end;
        seg = i;
        r = '';
        continue;
      }
      i++;
      continue;
    }
    if (c === 96) { // backtick: code span
      let run = 0;
      while (i + run < end && s.charCodeAt(i + run) === 96) run++;
      const close = findCodeClose(s, i + run, end, run);
      if (close !== -1) {
        flush(i);
        let content = s.slice(i + run, close - run).replace(/\n/g, ' ');
        if (content.length >= 2 && content.charCodeAt(0) === 32 && content.charCodeAt(content.length - 1) === 32) {
          let hasNonSpace = false;
          for (let q = 0; q < content.length; q++) { if (content.charCodeAt(q) !== 32) { hasNonSpace = true; break; } }
          if (hasNonSpace) content = content.slice(1, -1);
        }
        if (cx.plain) out.push(content);
        else out.push(`<code>${escEncode(content)}</code>`);
        i = close;
        seg = i;
        r = '';
        continue;
      }
      i += run;
      continue;
    }
    if (c === 42 || c === 95) { // '*' or '_'
      // Cheap pre-checks mirroring findEm's early returns, run BEFORE
      // ensureMask() so a delimiter that cannot open emphasis never
      // pays for the mask. The opener run cannot back up when the char
      // before it is not the delimiter (the mask never introduces
      // '*'/'_'), so then findEm's `n` is exactly effR().
      let run = 0;
      while (i + run < end && s.charCodeAt(i + run) === c) run++;
      const nx = nextChar(s, i + run, end);
      if (nx === '' || isWsCh(nx)) { i++; continue; }
      if (i === start || s.charCodeAt(i - 1) !== c) {
        const prev = effR();
        if (prev !== '') {
          // '_' after an alnum char can never open: both the d!=='' and
          // the d==='' early returns in findEm fire for it.
          if (c === 95 && isAlnumCp(prev.codePointAt(0))) { i++; continue; }
          // Next char is punctuation and prev is neither punct nor
          // space: findEm's first early return fires.
          if (isPunctCp(nx.codePointAt(0), false) && !isPunctOrSpace(prev)) { i++; continue; }
        }
      }
      ensureMask();
      const em = findEm(s, i, end, cx, effR(), mask, maskOff, start);
      if (em) {
        flush(i);
        out.push(em.html);
        i = em.end;
        seg = i;
        r = '';
        continue;
      }
      i++;
      continue;
    }
    if (c === 126) { // '~': strikethrough
      // Cheap pre-checks mirroring findDel's early returns, run BEFORE
      // ensureMask() (same idea as the '*'/'_' branch above).
      let run = 0;
      while (i + run < end && s.charCodeAt(i + run) === 126) run++;
      const nx = nextChar(s, i + run, end);
      if (run > 2 || nx === '' || isWsCh(nx) || nx === '~') { i += run; continue; }
      if (isPunctCp(nx.codePointAt(0), true)) {
        const prev = effR();
        if (prev !== '' && !isPunctOrSpace(prev)) { i += run; continue; }
      }
      ensureMask();
      const del = findDel(s, i, end, cx, effR(), mask, maskOff, start);
      if (del) {
        flush(i);
        out.push(del.html);
        i = del.end;
        seg = i;
        r = '';
        continue;
      }
      i += run;
      continue;
    }
    if (!cx.inLink && ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 46 || c === 95 || c === 43 || c === 45)) {
      // A scheme can only match when the 2nd char fits (http(s):// and
      // ftp:// need 't', www. needs lowercase 'w', mailto: needs 'a',
      // xmpp: needs 'm'); otherwise only the bare-email path can match,
      // which needs a word boundary. Skip matchExtUrl when neither can
      // succeed -- the common mid-word h/f/w/m/x. The previous char is
      // read with charCodeAt here (no prevChar call): for the
      // word-boundary test only its email-local-ness matters, and a
      // surrogate half is never email-local, exactly like the full char.
      const pc = i > start ? s.charCodeAt(i - 1) : -1;
      const nc = i + 1 < end ? s.charCodeAt(i + 1) : -1;
      const scheme2 = (c === 104 || c === 72 || c === 102 || c === 70) ? (nc === 116 || nc === 84)
        : c === 119 ? nc === 119
        : (c === 109 || c === 77) ? (nc === 97 || nc === 65)
        : (c === 120 || c === 88) ? (nc === 109 || nc === 77) : false;
      const boundary = pc === -1 || !isEmailLocalCode(pc);
      let tryExt = scheme2 || boundary;
      if (tryExt && !scheme2) {
        // Bare-email path only: it needs an '@' in this slice.
        if (hasAt === -1) { const at = s.indexOf('@', start); hasAt = (at !== -1 && at < end) ? 1 : 0; }
        if (hasAt === 0) tryExt = false;
      }
      if (tryExt) {
        const prev = i > start ? prevChar(s, i) : '';
        const ext = matchExtUrl(s, i, prev, cx.inLink, end);
        if (ext) {
          flush(i);
          if (cx.plain) {
            out.push(ext.text);
          } else {
            const clean = cleanUrl(ext.href);
            if (clean === null) out.push(escEncode(ext.text));
            else out.push(`<a href="${escEncode(clean)}">${escEncode(ext.text)}</a>`);
          }
          i += ext.len;
          seg = i;
          r = '';
          continue;
        }
      }
    }
    i++;
  }
  flush(end);
  return out.join('');
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

// Expand the leading whitespace of a line to spaces, assuming the line
// starts at column `startCol` (tab stops of 4).
function expandLeadingFrom(line, startCol) {
  let col = startCol;
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) { col += 4 - (col % 4); i++; }
    else break;
  }
  if (i === 0) return line;
  return ' '.repeat(col - startCol) + line.slice(i);
}

// Consume `n` columns of leading whitespace from a line starting at index
// `idx` (a tab that straddles the cut leaves spaces behind). Returns the
// index where the content starts.
function consumeCols(line, idx, n) {
  let col = 0;
  let i = idx;
  const len = line.length;
  while (i < len && col < n) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) {
      const w = 4 - (col % 4);
      if (col + w <= n) { col += w; i++; }
      else return i; // the tab straddles: the caller re-adds the spaces
    } else break;
  }
  return i;
}

function isHr(line) {
  const ind = indentOf(line);
  if (ind.col > 3) return false;
  const s = line.slice(ind.idx);
  if (s.length < 3) return false;
  const ch = s.charCodeAt(0);
  if (ch !== 45 && ch !== 95 && ch !== 42) return false;
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === ch) count++;
    else if (c === 32 || c === 9) continue;
    else return false;
  }
  return count >= 3;
}

function matchAtx(line) {
  const ind = indentOf(line);
  if (ind.col > 3) return null;
  let i = ind.idx;
  let level = 0;
  while (i < line.length && line.charCodeAt(i) === 35) { level++; i++; }
  if (level === 0 || level > 6) return null;
  if (i < line.length && line.charCodeAt(i) !== 32 && line.charCodeAt(i) !== 9) return null;
  let text = line.slice(i).trim();
  // Strip a closing hash sequence: the whole text is hashes, or the
  // hashes are preceded by a space/tab.
  if (text.length > 0 && text.charCodeAt(text.length - 1) === 35) {
    let k = text.length;
    while (k > 0 && text.charCodeAt(k - 1) === 35) k--;
    const before = text.slice(0, k);
    if (before === '' || before.charCodeAt(before.length - 1) === 32 || before.charCodeAt(before.length - 1) === 9) {
      text = before.trim();
    }
  }
  return { level, text };
}

function matchFence(line) {
  const ind = indentOf(line);
  if (ind.col > 3) return null;
  let i = ind.idx;
  const ch = line.charCodeAt(i);
  if (ch !== 96 && ch !== 126) return null;
  let len = 0;
  while (i + len < line.length && line.charCodeAt(i + len) === ch) len++;
  if (len < 3) return null;
  const info = line.slice(i + len);
  if (ch === 96 && info.indexOf('`') !== -1) return null;
  return { ch: String.fromCharCode(ch), len, indent: ind.col, indentLen: ind.idx, info };
}

// A line that starts a fenced code block, or looks like one: 3+ backticks
// or tildes at indent <= 3. For ending a list item (or a paragraph) the
// info string does not matter -- a backtick fence whose info contains
// backticks is not a valid fence, but it still cannot be a lazy
// continuation line (doc-19: ```inner backticks``` ends the item and is
// then parsed as a paragraph with a code span).
function isFenceLike(line) {
  const ind = indentOf(line);
  if (ind.col > 3) return false;
  const ch = line.charCodeAt(ind.idx);
  if (ch !== 96 && ch !== 126) return false;
  let len = 0;
  while (ind.idx + len < line.length && line.charCodeAt(ind.idx + len) === ch) len++;
  return len >= 3;
}
function isFenceClose(line, fence) {
  const ind = indentOf(line);
  if (ind.col > 3) return false;
  let i = ind.idx;
  let len = 0;
  while (i + len < line.length && line.charCodeAt(i + len) === fence.ch.charCodeAt(0)) len++;
  if (len < fence.len) return false;
  for (let j = i + len; j < line.length; j++) {
    if (line.charCodeAt(j) !== 32 && line.charCodeAt(j) !== 9) return false;
  }
  return true;
}

// A setext underline line (indent 0-3, =+ or -+ contiguous, trailing
// spaces only). Returns 1 for '=', 2 for '-', or 0.
function setextLevel(line) {
  const ind = indentOf(line);
  if (ind.col > 3) return 0;
  const s = line.slice(ind.idx);
  if (s.length === 0) return 0;
  const ch = s.charCodeAt(0);
  if (ch !== 61 && ch !== 45) return 0;
  let i = 1;
  while (i < s.length && s.charCodeAt(i) === ch) i++;
  while (i < s.length && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
  if (i !== s.length) return 0;
  return ch === 61 ? 1 : 2;
}

// Match a list item marker at the start of a line. `pat` is null for the
// first item of a list, or the marker pattern for subsequent items:
// {bullet} for unordered, {delim} for ordered. Returns null when the line
// does not start an item.
function matchListMarker(line, pat) {
  const ind = indentOf(line);
  if (ind.col > 3) return null;
  let i = ind.idx;
  const c = line.charCodeAt(i);
  let ordered = false;
  let start = null;
  let markerLen = 0;
  if (pat && pat.bullet) {
    if (c !== pat.bullet.charCodeAt(0)) return null;
    markerLen = 1;
  } else if (pat && pat.delim) {
    if (c < 48 || c > 57) return null;
    let j = i;
    while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
    if (j - i > 9) return null;
    if (j >= line.length || line.charCodeAt(j) !== pat.delim.charCodeAt(0)) return null;
    ordered = true;
    start = parseInt(line.slice(i, j), 10);
    markerLen = j - i + 1;
  } else if (c === 45 || c === 42 || c === 43) {
    markerLen = 1;
  } else if (c >= 48 && c <= 57) {
    let j = i;
    while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
    if (j - i > 9) return null;
    if (j >= line.length || (line.charCodeAt(j) !== 46 && line.charCodeAt(j) !== 41)) return null;
    ordered = true;
    start = parseInt(line.slice(i, j), 10);
    markerLen = j - i + 1;
  } else {
    return null;
  }
  const markerCol = ind.col;
  const b = markerCol + markerLen; // the column where the whitespace starts
  let k = i + markerLen;
  if (k >= line.length) {
    return { ordered, start, bullet: line[i], markerCol, b, R: b + 1, content: '', empty: true };
  }
  const wc = line.charCodeAt(k);
  if (wc !== 32 && wc !== 9) return null;
  // Expand the whitespace after the marker, starting at column b.
  const expanded = expandLeadingFrom(line.slice(k), b);
  const ws = expanded.search(/[^ ]/);
  const wsCols = ws === -1 ? expanded.length : ws;
  if (ws === -1) {
    // Only whitespace after the marker: an empty item.
    return { ordered, start, bullet: line[i], markerCol, b, R: b + 1, content: '', empty: true };
  }
  let R;
  let content;
  if (wsCols > 4) {
    R = b + 1;
    content = ' '.repeat(wsCols - 1) + expanded.slice(wsCols);
  } else {
    R = b + wsCols;
    content = expanded.slice(wsCols);
  }
  return { ordered, start, bullet: line[i], markerCol, b, R, content, empty: false };
}

// The block-level HTML start test (marked's htmlBeginRegex, indent 0..a).
const BLOCK_TAGS = new Set(['address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body', 'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem', 'meta', 'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'search', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'title', 'tr', 'track', 'ul']);
function isHtmlBlockStart(line, maxIndent) {
  const ind = indentOf(line);
  if (ind.col > maxIndent) return false;
  const s = line.slice(ind.idx);
  if (s.charCodeAt(0) !== 60) return false;
  // (1) <script|pre|style|textarea + [\s>]
  const m1 = /^<(script|pre|style|textarea)([\s>]|$)/i.exec(s);
  if (m1) return true;
  // (2) comment
  if (s.startsWith('<!--')) return true;
  // (3) <?...?>
  if (s.charCodeAt(1) === 63) return true;
  // (4) <!Letter
  if (s.charCodeAt(1) === 33 && s.length > 2 && ((s.charCodeAt(2) >= 65 && s.charCodeAt(2) <= 90) || (s.charCodeAt(2) >= 97 && s.charCodeAt(2) <= 122))) return true;
  // (5) <![CDATA[
  if (s.startsWith('<![CDATA[')) return true;
  // (6) a block-level tag, open or close
  let j = 1;
  let closing = false;
  if (s.charCodeAt(j) === 47) { closing = true; j++; }
  let nameEnd = j;
  while (nameEnd < s.length) {
    const cc = s.charCodeAt(nameEnd);
    if ((cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || (cc >= 48 && cc <= 57) || cc === 45) nameEnd++;
    else break;
  }
  if (nameEnd > j) {
    const name = s.slice(j, nameEnd).toLowerCase();
    if (BLOCK_TAGS.has(name)) {
      const after = s.charCodeAt(nameEnd);
      if (after === 32 || after === 9 || after === 10 || after === 13 || after === 62 || (after === 47 && s.charCodeAt(nameEnd + 1) === 62) || nameEnd >= s.length) return true;
    }
  }
  return false;
}

// Whether a line interrupts a paragraph. `anyOrdered` selects the
// blockquote lazy rule (any ordered start number interrupts, and a list
// marker followed only by whitespace also interrupts); `table` selects
// whether a table header interrupts (the GFM paragraph rule includes it,
// the blockquote lazy rule does not).
function isInterrupting(lines, idx, anyOrdered, table) {
  const line = lines[idx];
  if (isBlank(line)) return true;
  const ind = indentOf(line);
  if (ind.col > 3) return false;
  if (matchAtx(line)) return true;
  if (matchFence(line)) return true;
  if (isHr(line)) return true;
  if (line[ind.idx] === '>') return true;
  if (isHtmlBlockStart(line, 3)) return true;
  if (table && isTableStart(lines, idx)) return true;
  const lm = matchListMarker(line);
  if (lm) {
    if (anyOrdered) return true;
    if (!lm.empty && (!lm.ordered || lm.start === 1)) return true;
  }
  return false;
}

// A table delimiter row (indent 0-3, cells of '-' with optional ':'s).
// Returns the cell list or null.
function matchTableDelim(line) {
  const ind = indentOf(line);
  if (ind.col > 3) return null;
  const s = line.slice(ind.idx);
  let i = 0;
  const n = s.length;
  const cells = [];
  const skipSpaces = () => { while (i < n && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++; };
  skipSpaces();
  if (i < n && s.charCodeAt(i) === 124) { i++; skipSpaces(); }
  for (;;) {
    let hasColon = false;
    if (i < n && s.charCodeAt(i) === 58) { hasColon = true; i++; }
    let dashes = 0;
    while (i < n && s.charCodeAt(i) === 45) { dashes++; i++; }
    if (dashes === 0) return null;
    if (i < n && s.charCodeAt(i) === 58) { hasColon = true; i++; }
    cells.push(hasColon);
    skipSpaces();
    if (i < n && s.charCodeAt(i) === 124) {
      i++;
      skipSpaces();
      if (i >= n) break; // a trailing '|' ends the delimiter row
      continue;
    }
    break;
  }
  if (i < n) return null;
  if (cells.length === 0) return null;
  return cells;
}
// Whether the line at idx starts a table (a header line followed by a
// delimiter row that contains a '|' or ':'). Used for the paragraph
// interruption check: the cell counts are NOT compared here (marked's
// paragraph regex embeds the raw table pattern).
function isTableStart(lines, idx) {
  if (idx + 1 >= lines.length) return false;
  const line = lines[idx];
  const ind = indentOf(line);
  if (ind.col > 3) return false;
  if (line[ind.idx] === undefined || line[ind.idx] === ' ' || line[ind.idx] === '\t') return false;
  const delim = matchTableDelim(lines[idx + 1]);
  if (!delim) return false;
  const dline = lines[idx + 1];
  return dline.indexOf('|') !== -1 || dline.indexOf(':') !== -1;
}
// Split a table row into cells (marked's de()): unescaped '|' splits,
// escaped '\|' stays, leading/trailing empty edge cells are dropped.
function splitTableRow(row, count) {
  const cells = [];
  let cur = '';
  let i = 0;
  const n = row.length;
  while (i < n) {
    const c = row.charCodeAt(i);
    if (c === 124) { // '|': a split point unless escaped (odd backslashes)
      let b = 0;
      for (let k = i - 1; k >= 0 && row.charCodeAt(k) === 92; k--) b++;
      if (b % 2 === 1) { cur += '|'; i++; continue; }
      cells.push(cur); cur = ''; i++; continue;
    }
    cur += row[i];
    i++;
  }
  cells.push(cur);
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  for (let k = 0; k < cells.length; k++) cells[k] = cells[k].trim().replace(/\\\|/g, '|');
  if (count !== undefined) {
    while (cells.length < count) cells.push('');
    if (cells.length > count) cells.length = count;
  }
  return cells;
}
function tableAlignOf(delimCell) {
  const t = delimCell.trim();
  const left = t.charCodeAt(0) === 58;
  const right = t.charCodeAt(t.length - 1) === 58;
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

// Match a link reference definition starting at line i. Returns
// {label, href, title, end} (end = the index of the first line after the
// definition) or null. The definition may span several lines (a label or
// a quoted title can run over multiple lines), so up to twenty lines are
// joined for the scan.
function matchDef(lines, i, end) {
  const joined = lines.slice(i, Math.min(i + 20, end)).join('\n');
  const m = /^ {0,3}\[/.exec(joined);
  if (!m) return null;
  const brIdx = joined.indexOf('[', 0);
  if (brIdx === -1 || brIdx > 3) return null;
  let j = brIdx + 1;
  const labelStart = j;
  let labelEnd = -1;
  while (j < joined.length) {
    const c = joined.charCodeAt(j);
    if (c === 92) { j += 2; continue; }
    if (c === 93) { labelEnd = j; break; } // ']'
    if (c === 91) return null; // an unescaped '[' in a label
    if (c === 10) {
      // A newline is allowed in a label unless it starts a blank line.
      let k = j + 1;
      while (k < joined.length && (joined.charCodeAt(k) === 32 || joined.charCodeAt(k) === 9)) k++;
      if (k < joined.length && joined.charCodeAt(k) === 10) return null;
      j++;
      continue;
    }
    j++;
  }
  if (labelEnd === -1) return null;
  const labelRaw = joined.slice(labelStart, labelEnd);
  if (labelRaw.trim() === '') return null;
  j = labelEnd + 1;
  if (joined.charCodeAt(j) !== 58) return null; // ':'
  j++;
  while (j < joined.length && joined.charCodeAt(j) === 32) j++;
  if (j < joined.length && joined.charCodeAt(j) === 10) {
    j++;
    while (j < joined.length && (joined.charCodeAt(j) === 32 || joined.charCodeAt(j) === 9)) j++;
  }
  if (j >= joined.length) return null;
  let href = '';
  let isAngle = false;
  if (joined.charCodeAt(j) === 60) { // '<' angle destination
    let k = j + 1;
    let ok = false;
    while (k < joined.length) {
      const c = joined.charCodeAt(k);
      if (c === 92 && k + 1 < joined.length) { k += 2; continue; }
      if (c === 10) break;
      if (c === 62) { ok = true; break; }
      k++;
    }
    if (!ok) return null;
    href = joined.slice(j + 1, k);
    isAngle = true;
    j = k + 1;
  } else {
    let k = j;
    while (k < joined.length) {
      const c = joined.charCodeAt(k);
      if (c === 32 || c === 9 || c === 10 || (c >= 0 && c <= 31)) break;
      k++;
    }
    if (k === j) return null;
    href = joined.slice(j, k);
    j = k;
  }
  if (!isAngle) {
    let depth = 0;
    for (let k = 0; k < href.length; k++) {
      const c = href.charCodeAt(k);
      if (c === 92) { k++; continue; }
      if (c === 40) depth++;
      else if (c === 41) {
        depth--;
        if (depth < 0) return null;
      }
    }
    if (depth !== 0) return null;
  }
  let title = null;
  let save = j;
  // A title must be separated from the destination by at least one space
  // or tab, or by a newline followed by spaces/tabs (a title on the next
  // line). Without a separator there is no title.
  let k = j;
  let sep = false;
  while (k < joined.length && joined.charCodeAt(k) === 32) { k++; sep = true; }
  if (k < joined.length && joined.charCodeAt(k) === 10) {
    let m2 = k + 1;
    while (m2 < joined.length && (joined.charCodeAt(m2) === 32 || joined.charCodeAt(m2) === 9)) m2++;
    if (m2 < joined.length && (joined.charCodeAt(m2) === 34 || joined.charCodeAt(m2) === 39 || joined.charCodeAt(m2) === 40)) { k = m2; sep = true; }
  }
  if (sep && k < joined.length) {
    const q = joined.charCodeAt(k);
    if (q === 34 || q === 39 || q === 40) {
      const closeQ = q === 40 ? 41 : q;
      let m2 = k + 1;
      let ok = false;
      let blankInTitle = false;
      while (m2 < joined.length) {
        const c = joined.charCodeAt(m2);
        if (c === 92 && m2 + 1 < joined.length) { m2 += 2; continue; }
        if (c === 10) {
          // A blank line inside a title invalidates the definition.
          let m3 = m2 + 1;
          while (m3 < joined.length && (joined.charCodeAt(m3) === 32 || joined.charCodeAt(m3) === 9)) m3++;
          if (m3 >= joined.length || joined.charCodeAt(m3) === 10) { blankInTitle = true; break; }
        }
        if (c === closeQ) { ok = true; break; }
        m2++;
      }
      if (ok && !blankInTitle) {
        title = joined.slice(k + 1, m2);
        j = m2 + 1;
        // If extra text follows the title, the definition is still valid
        // but without the title (marked backtracks the optional title).
        let m4 = j;
        while (m4 < joined.length && (joined.charCodeAt(m4) === 32 || joined.charCodeAt(m4) === 9)) m4++;
        if (m4 < joined.length && joined.charCodeAt(m4) !== 10) { title = null; j = save; }
      }
    }
  }
  while (j < joined.length && (joined.charCodeAt(j) === 32 || joined.charCodeAt(j) === 9)) j++;
  if (j < joined.length && joined.charCodeAt(j) !== 10) return null;
  const consumed = joined.slice(0, j);
  const endLine = i + (consumed.split('\n').length - 1);
  return {
    label: normalizeLabel(labelRaw),
    href: unescapePunct(href),
    title: title === null ? null : unescapePunct(title),
    end: endLine + 1,
  };
}

// Parse lines[start..end) into block nodes. `top` selects whether a run of
// text lines is a paragraph (top=true) or a text token (top=false, inside
// a list item). Returns {blocks, blankSep, end}.
function parseBlocks(lines, start, end, refs, top, endsNl) {
  if (top === undefined) top = true;
  if (endsNl === undefined) endsNl = true;
  const blocks = [];
  let blankSep = false;
  let i = start;
  let seenBlock = false;
  while (i < end) {
    const line = lines[i];
    if (isBlank(line)) {
      let k = i + 1;
      while (k < end && isBlank(lines[k])) k++;
      if (seenBlock && k < end) blankSep = true;
      i = k;
      continue;
    }
    seenBlock = true;
    const ind = indentOf(line);
    const blockStart = i;
    // Indented code.
    if (ind.col >= 4) {
      const content = [];
      let j = i;
      while (j < end) {
        const l2 = lines[j];
        if (isBlank(l2)) {
          let k = j + 1;
          while (k < end && isBlank(lines[k])) k++;
          if (k < end && indentOf(lines[k]).col >= 4) {
            for (let m = j; m < k; m++) content.push(stripIndent(lines[m], 4));
            j = k;
            continue;
          }
          break;
        }
        if (indentOf(l2).col >= 4) { content.push(stripIndent(l2, 4)); j++; }
        else break;
      }
      while (content.length && content[content.length - 1].trim() === '') content.pop();
      blocks.push({ t: 'code', lang: '', text: content.join('\n'), s: blockStart, e: j });
      i = j;
      continue;
    }
    // Fenced code.
    const fence = matchFence(line);
    if (fence) {
      const content = [];
      let j = i + 1;
      // marked's indentCodeCompensation (Dt) applies only to backtick
      // fences and strips by CHARACTER count: min(leading-whitespace
      // chars, opening-fence indent string length) — a tab counts as
      // one char, so a tab-indented line under a 2-space fence loses
      // the tab entirely (doc-13). Tilde fences are not dedented.
      if (fence.ch === '`') {
        const n = fence.indentLen;
        while (j < end && !isFenceClose(lines[j], fence)) {
          content.push(stripFenceIndent(lines[j], n));
          j++;
        }
      } else {
        while (j < end && !isFenceClose(lines[j], fence)) {
          content.push(lines[j]);
          j++;
        }
      }
      if (j < end) j++; // consume the closing fence
      const info = unescapePunct(fence.info.trim());
      const lang = info === '' ? '' : info.split(/\s+/)[0];
      blocks.push({ t: 'code', lang, text: content.join('\n'), s: blockStart, e: j });
      i = j;
      continue;
    }
    // Thematic break.
    if (isHr(line)) { blocks.push({ t: 'hr', s: blockStart, e: i + 1 }); i++; continue; }
    // ATX heading.
    const atx = matchAtx(line);
    if (atx) { blocks.push({ t: 'heading', level: atx.level, text: atx.text, s: blockStart, e: i + 1 }); i++; continue; }
    // Blockquote.
    if (line[ind.idx] === '>') {
      const res = parseBlockquote(lines, i, end, refs);
      blocks.push(res.node);
      i = res.end;
      continue;
    }
    // List.
    const lm0 = matchListMarker(line);
    if (lm0) {
      const res = parseList(lines, i, end, refs);
      blocks.push(res.node);
      i = res.end;
      continue;
    }
    // HTML block.
    const html = matchHtmlBlock(lines, i, end, endsNl);
    if (html) { blocks.push({ t: 'html', text: html.text, s: blockStart, e: html.end }); i = html.end; continue; }
    // Link reference definition.
    const def = matchDef(lines, i, end);
    if (def) {
      if (!refs.has(def.label)) refs.set(def.label, { href: def.href, title: def.title });
      i = def.end;
      continue;
    }
    // Table.
    const table = matchTable(lines, i, end);
    if (table) { blocks.push(table.node); i = table.end; continue; }
    // A run of text lines: a paragraph (top) or a text token (list item).
    const run = collectTextRun(lines, i, end, top, endsNl);
    if (run.headingLevel !== 0) {
      blocks.push({ t: 'heading', level: run.headingLevel, text: run.text.trim(), s: blockStart, e: run.end });
    } else {
      blocks.push({ t: top ? 'para' : 'text', text: run.text, s: blockStart, e: run.end });
    }
    i = run.end;
  }
  return { blocks, blankSep, end: i };
}

// Collect a run of text lines starting at line i. Returns
// {text, headingLevel, end}. A setext underline turns the run into a
// heading. When top is false, an indented continuation line is an
// indented-code line merged into the text with its indent stripped.
function collectTextRun(lines, i, end, top, endsNl) {
  const parts = [lines[i]];
  let j = i + 1;
  let headingLevel = 0;
  while (j < end) {
    const l2 = lines[j];
    if (isBlank(l2)) {
      // A whitespace-only line that is the last line of the range and is
      // not followed by a newline in the source is a paragraph
      // continuation (marked's paragraph regex excludes only a
      // whitespace-only line followed by '\n'). An empty line never is.
      if (l2.length > 0 && j === end - 1 && !endsNl) { parts.push(l2); j++; continue; }
      break;
    }
    const sl = setextLevel(l2);
    if (sl !== 0) { headingLevel = sl; j++; break; }
    // Inside a list item (top=false) a text run is a single-line token,
    // so any list marker ends it; at the top level only a bullet or an
    // ordered list starting with 1 interrupts a paragraph.
    if (isInterrupting(lines, j, !top, true)) break;
    if (!top && indentOf(l2).col >= 4) {
      parts.push(stripIndent(l2, 4));
      j++;
      continue;
    }
    parts.push(l2);
    j++;
  }
  return { text: parts.join('\n'), headingLevel, end: j };
}

// Strip the blockquote marker from a line (indent 0-3, '>', then one
// space or a partially-consumed tab). The whitespace after the marker is
// tab-expanded first, then one space is removed.
function stripQuoteMarker(line, ind) {
  const after = line.slice(ind.idx + 1);
  if (after.length === 0) return '';
  const expanded = expandLeadingFrom(after, ind.col + 1);
  if (expanded.charCodeAt(0) === 32) return expanded.slice(1);
  return expanded;
}

// Parse a blockquote starting at line i. The quote's lines are collected
// in chunks (a chunk is a run of '>' lines plus the lazy lines before
// them); each chunk is parsed separately and the results are merged the
// way marked does: paragraphs merge across chunks, indented code lines
// merge into the preceding paragraph, and a chunk ending in a
// heading/hr/html/table/code ends the quote. Returns {node, end}.
function parseBlockquote(lines, i, end, refs) {
  // Collect the quote's content lines and the chunk boundaries.
  const content = [];
  const rawIdx = [];
  const chunkStart = [];
  const isLazy = [];
  let j = i;
  let prevQuote = false; // the previous collected line was a '>' line
  let first = true;
  while (j < end) {
    const line = lines[j];
    const ind = indentOf(line);
    if (ind.col <= 3 && line[ind.idx] === '>') {
      content.push(stripQuoteMarker(line, ind));
      rawIdx.push(j);
      chunkStart.push(first);
      isLazy.push(false);
      first = false;
      prevQuote = true;
      j++;
      continue;
    }
    if (isBlank(line)) break; // a blank line ends the quote
    // A lazy continuation line: only if the quote's current content is a
    // paragraph (the previous content line is not blank — marked's
    // blockquote regex tries the paragraph alternative first, and its
    // first line is unrestricted, so a '>' line whose content is a
    // heading, a nested quote, an hr, etc. still leaves the paragraph
    // open) and the line itself does not start an interrupting block
    // (the blockquote lazy rule: no table interruption, any ordered list
    // number interrupts).
    const lastContent = content.length > 0 ? content[content.length - 1] : '';
    if (lastContent.trim() !== '' && !isInterrupting(lines, j, true, false)) {
      content.push(line);
      rawIdx.push(j);
      chunkStart.push(prevQuote); // a lazy line after a '>' line starts a chunk
      isLazy.push(true);
      prevQuote = false;
      j++;
      continue;
    }
    break;
  }
  const rawEnd = j;
  // Apply the setext replace: a lazy setext-underline line inside a chunk
  // (not the chunk's first line, which has no preceding newline in the
  // chunk's text) is indented by 4 spaces so it cannot form a heading.
  // Marked applies this before stripping the '>' markers, so only lazy
  // lines are affected.
  for (let k = 1; k < content.length; k++) {
    if (isLazy[k] && !chunkStart[k] && setextLevel(content[k]) !== 0) {
      content[k] = '    ' + content[k].replace(/^ {0,3}/, '');
    }
  }
  // Parse chunk by chunk.
  const blocks = [];
  let pos = 0;
  const chunkBounds = [];
  for (let k = 0; k < content.length; k++) if (chunkStart[k]) chunkBounds.push(k);
  chunkBounds.push(content.length);
  let ci = 0;
  while (pos < content.length) {
    // Find the next chunk boundary after pos.
    let chunkEnd = content.length;
    for (let k = 0; k < chunkBounds.length; k++) {
      if (chunkBounds[k] > pos) { chunkEnd = chunkBounds[k]; break; }
    }
    const res = parseBlocks(content, pos, chunkEnd, refs, true, false);
    const chunkBlocks = res.blocks;
    if (chunkBlocks.length === 0) { pos = chunkEnd; continue; }
    const last = blocks.length > 0 ? blocks[blocks.length - 1] : null;
    const firstB = chunkBlocks[0];
    if (last && last.t === 'para' && firstB.t === 'para') {
      // Merge the paragraphs across the chunk boundary.
      last.text += '\n' + firstB.text;
      last.e = firstB.e;
      blocks.push(...chunkBlocks.slice(1));
    } else if (last && last.t === 'para' && firstB.t === 'code') {
      // Merge an indented code block into the preceding paragraph.
      last.text += '\n' + firstB.text;
      last.e = firstB.e;
      blocks.push(...chunkBlocks.slice(1));
    } else if (last && (last.t === 'list' || last.t === 'blockquote')) {
      // Re-parse the last block with the new chunk's lines appended.
      const reparsed = parseBlocks(content, last.s, chunkEnd, refs, true, false);
      const consumed = reparsed.end;
      blocks.splice(blocks.length - 1, 1, ...reparsed.blocks);
      pos = consumed;
      continue;
    } else {
      blocks.push(...chunkBlocks);
    }
    // A chunk ending in a heading/hr/html/table/code ends the quote when
    // more lines follow.
    const tail = blocks[blocks.length - 1];
    if (tail && (tail.t === 'heading' || tail.t === 'hr' || tail.t === 'html' || tail.t === 'table' || tail.t === 'code')) {
      if (chunkEnd < content.length) {
        // The quote ends here; the remaining lines are not consumed.
        const endIdx = rawIdx[chunkEnd];
        return { node: { t: 'blockquote', children: blocks, s: i, e: endIdx }, end: endIdx };
      }
    }
    pos = chunkEnd;
    ci++;
  }
  return { node: { t: 'blockquote', children: blocks, s: i, e: rawEnd }, end: rawEnd };
}

// marked's ge(): strip trailing blank lines from a block's raw text,
// but only when there are two or more of them; with zero or one the
// text is kept as-is (so a single trailing newline survives).
function geStrip(raw) {
  const lines = raw.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && /^\s*$/.test(lines[t])) t--;
  if (lines.length - t <= 2) return raw;
  return lines.slice(0, t + 1).join('\n');
}

// Match an HTML block starting at line i. Returns {text, end} or null.
// The text is the block's lines joined with '\n', plus a trailing '\n'
// when the block is not followed by a blank line (marked's ge() strips
// the trailing blank lines only when the raw ends with two or more).
function matchHtmlBlock(lines, i, end, endsNl) {
  const line = lines[i];
  const ind = indentOf(line);
  if (ind.col > 3) return null;
  const s = line.slice(ind.idx);
  if (s.charCodeAt(0) !== 60) return null;
  const rest = s.slice(1);
  let textLines = null;
  let j = i + 1;
  // Whether the block ends at a terminator (types 1-5) or runs to a
  // blank line (type 6): only the terminator types take the ge() rule
  // for the trailing newline.
  let terminator = false;
  // (1) <script|pre|style|textarea + [\s>]: lazy to the matching close tag.
  const m1 = /^(script|pre|style|textarea)([\s>]|$)/i.exec(rest);
  if (m1) {
    terminator = true;
    const tag = m1[1].toLowerCase();
    const closeRe = new RegExp(`</${tag}\\s*>`, 'i');
    textLines = [line];
    if (!closeRe.test(line)) {
      j = i + 1;
      while (j < end) {
        textLines.push(lines[j]);
        if (closeRe.test(lines[j])) { j++; break; }
        j++;
      }
    }
  } else if (s.startsWith('<!--')) {
    // (2) Comment (including <!--> and <!--->).
    terminator = true;
    if (s.startsWith('<!-->') || s.startsWith('<!--->') || s.indexOf('-->') !== -1) {
      textLines = [line];
    } else {
      textLines = [line];
      j = i + 1;
      while (j < end) {
        textLines.push(lines[j]);
        if (lines[j].indexOf('-->') !== -1) { j++; break; }
        j++;
      }
    }
  } else if (s.charCodeAt(1) === 63) {
    // (3) <?...?>
    terminator = true;
    textLines = [line];
    if (line.indexOf('?>') === -1) {
      j = i + 1;
      while (j < end) {
        textLines.push(lines[j]);
        if (lines[j].indexOf('?>') !== -1) { j++; break; }
        j++;
      }
    }
  } else if (s.charCodeAt(1) === 33 && s.length > 2 && ((s.charCodeAt(2) >= 65 && s.charCodeAt(2) <= 90) || (s.charCodeAt(2) >= 97 && s.charCodeAt(2) <= 122))) {
    // (4) <!Letter...>
    terminator = true;
    textLines = [line];
    if (line.indexOf('>') === -1) {
      j = i + 1;
      while (j < end) {
        textLines.push(lines[j]);
        if (lines[j].indexOf('>') !== -1) { j++; break; }
        j++;
      }
    }
  } else if (s.startsWith('<![CDATA[')) {
    // (5) <![CDATA[...]]>
    terminator = true;
    textLines = [line];
    if (line.indexOf(']]>') === -1) {
      j = i + 1;
      while (j < end) {
        textLines.push(lines[j]);
        if (lines[j].indexOf(']]>') !== -1) { j++; break; }
        j++;
      }
    }
  } else {
    // (6) A block-level tag, (7) a complete open tag alone on a line,
    // (8) a complete close tag alone on a line: until a blank line.
    const nameMatch = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(s);
    if (!nameMatch) return null;
    const name = nameMatch[1].toLowerCase();
    const isBlockTag = BLOCK_TAGS.has(name);
    const isCompleteOpen = /^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*\s*\/?>$/.test(s.trim());
    const isCompleteClose = /^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>$/.test(s.trim());
    if (!isBlockTag && !isCompleteOpen && !isCompleteClose) return null;
    textLines = [];
    j = i;
    while (j < end && !isBlank(lines[j])) { textLines.push(lines[j]); j++; }
  }
  let text = textLines.join('\n');
  if (terminator) {
    // marked's regex consumes the newlines after the terminator line
    // (one for the line itself, then one per following empty line) and
    // ge() keeps the result unless it ends with two or more blank lines.
    let nl = 0;
    if (j < end) {
      nl = 1;
      let k = j;
      while (k < end && lines[k] === '') { nl++; k++; }
    } else if (endsNl) {
      nl = 1;
    }
    if (nl > 0) text += '\n'.repeat(nl);
    text = geStrip(text);
  } else {
    // A trailing newline is kept unless the block is followed by a blank
    // line (then ge() strips it) or the block ends at the end of the range
    // without a trailing newline in the source.
    const followedByBlank = j < end && isBlank(lines[j]);
    if (!followedByBlank && (j < end || endsNl)) text += '\n';
  }
  return { text, end: j };
}

// Match a table starting at line i. Returns {node, end} or null.
function matchTable(lines, i, end) {
  if (i + 1 >= end) return null;
  const headerLine = lines[i];
  const ind = indentOf(headerLine);
  if (ind.col > 3) return null;
  if (headerLine[ind.idx] === undefined) return null;
  const delim = matchTableDelim(lines[i + 1]);
  if (!delim) return null;
  const dline = lines[i + 1];
  if (dline.indexOf('|') === -1 && dline.indexOf(':') === -1) return null;
  const header = splitTableRow(headerLine.slice(ind.idx));
  if (header.length !== delim.length) return null;
  const align = [];
  const delimCells = splitTableRow(dline.slice(indentOf(dline).idx));
  for (let k = 0; k < delimCells.length; k++) align.push(tableAlignOf(delimCells[k]));
  const rows = [];
  let j = i + 2;
  while (j < end) {
    const l2 = lines[j];
    // A line of only spaces ends the table (marked's body lookahead is
    // (?! *\n ...)); a whitespace-only line containing a tab is a body
    // row of empty cells (doc-07: a lone '\t' line is a row).
    if (/^ *$/.test(l2)) break;
    const ind2 = indentOf(l2);
    if (l2.trim() === '') {
      rows.push(splitTableRow(l2.slice(ind2.idx), header.length));
      j++;
      continue;
    }
    if (ind2.col >= 4) break; // an indented code line ends the table
    if (isHr(l2) || matchAtx(l2) || matchFence(l2) || (ind2.col <= 3 && l2[ind2.idx] === '>') || isHtmlBlockStart(l2, 3) || tableBodyListBreak(l2)) break;
    rows.push(splitTableRow(l2.slice(ind2.idx), header.length));
    j++;
  }
  return { node: { t: 'table', header, align, rows, s: i, e: j }, end: j };
}
// Whether a line ends a table's body rows because it starts a list
// (marked's table regex: a bullet or a '1.'/'1)' marker followed by a
// space or tab).
function tableBodyListBreak(line) {
  const ind = indentOf(line);
  if (ind.col > 3) return false;
  const c = line.charCodeAt(ind.idx);
  if (c === 45 || c === 42 || c === 43) {
    const n = line.charCodeAt(ind.idx + 1);
    return n === 32 || n === 9 || ind.idx + 1 >= line.length;
  }
  if (c === 49) {
    const n = line.charCodeAt(ind.idx + 1);
    if (n === 46 || n === 41) {
      const m = line.charCodeAt(ind.idx + 2);
      return m === 32 || m === 9 || ind.idx + 2 >= line.length;
    }
  }
  return false;
}

// Parse a list starting at line i. Returns {node, end}.
function parseList(lines, i, end, refs) {
  const first = matchListMarker(lines[i]);
  const ordered = first.ordered;
  const start = ordered ? first.start : null;
  let delimChar = '.';
  if (ordered) {
    const m = /^\s*\d{1,9}([.)])/.exec(lines[i]);
    delimChar = m ? m[1] : '.';
  }
  const markerPat = ordered ? { delim: delimChar } : { bullet: first.bullet };
  const items = [];
  let j = i;
  let listEnd = i;
  let loose = false;
  let prevEndsBlank = false;
  while (j < end) {
    // Blank lines between items: skip them (the previous item's
    // endsBlank already records that they were there, which makes the
    // list loose when the next item is parsed).
    while (j < end && isBlank(lines[j])) j++;
    if (j >= end) break;
    const lm = matchListMarker(lines[j], j === i ? null : markerPat);
    if (!lm) break;
    if (j !== i && lm.ordered !== ordered) break;
    if (isHr(lines[j])) break;
    const item = parseListItem(lines, j, end, lm, refs);
    if (prevEndsBlank) loose = true;
    items.push(item);
    prevEndsBlank = item.endsBlank;
    j = item.end;
    listEnd = j; // the list ends at the last item's end (its first
    // trailing blank line), not past the blank lines
  }
  if (items.length === 0) return { node: { t: 'list', ordered, start, loose: false, items: [], s: i, e: i }, end: i };
  for (const it of items) if (it.blankSep) loose = true;
  const node = {
    t: 'list', ordered, start, loose, s: i, e: listEnd,
    items: items.map((it) => ({ blocks: it.blocks, task: it.task, checked: it.checked })),
  };
  return { node, end: listEnd };
}

// Parse one list item starting at line i (lm is the marker match).
// Returns {blocks, blankSep, endsBlank, task, checked, end}.
function parseListItem(lines, i, end, lm, refs) {
  const R = lm.R;
  const contentLines = [];
  const contentSrc = [];
  let empty = lm.empty;
  if (!empty) { contentLines.push(lm.content); contentSrc.push(i); }
  let j = i + 1;
  if (empty && j < end && isBlank(lines[j])) {
    return finishListItem(contentLines, refs, true, j + 1);
  }
  const clamp = Math.max(0, Math.min(3, R - 1));
  let y = empty;
  let m = lm.empty ? '' : lm.content;
  while (j < end) {
    const U = lines[j];
    const f = U;
    const Z = expandLeading(U);
    // A line starting a fence/heading/html/blockquote/new-bullet/hr at
    // indent <= clamp ends the item. A fence-like line (3+ backticks or
    // tildes) ends it even when the info string is invalid, since it
    // cannot be a lazy continuation.
    const indU = indentOf(U);
    let breaks = false;
    if (indU.col <= clamp) {
      if (isFenceLike(U) || matchAtx(U) || isHtmlBlockStart(U, clamp) || (U[indU.idx] === '>') || matchListMarker(U) || isHr(U)) breaks = true;
    }
    if (breaks) break;
    const nonSpace = Z.search(/[^ ]/);
    if (nonSpace >= R || !f.trim()) {
      contentLines.push(Z.slice(R));
      contentSrc.push(j);
    } else {
      if (y || m.replace(/\t/g, '    ').search(/[^ ]/) >= 4 || matchFence(m) || matchAtx(m) || isHtmlBlockStart(m, 3) || isHr(m)) break;
      let qe = f;
      if (/^ {0,3}(?:=+|-+) *$/.test(f)) {
        const lhead = `${m}\n${f}`;
        if (/^.+?\n {0,3}(=+|-+) *$/.test(lhead)) qe = '    ' + Z.replace(/^ {0,3}/, '');
      }
      contentLines.push(qe);
      contentSrc.push(j);
    }
    y = !f.trim();
    j++;
    m = Z.slice(R);
  }
  const endsBlank = contentLines.length > 0 && contentLines[contentLines.length - 1].trim() === '';
  // The item ends at its first trailing blank line (not past it): the
  // blank lines are left for the caller, so an enclosing parse sees the
  // blank separator (a blank line between a nested list and the next
  // paragraph of the item makes the outer list loose, cm-325).
  let lastNonBlank = contentLines.length - 1;
  while (lastNonBlank >= 0 && contentLines[lastNonBlank].trim() === '') lastNonBlank--;
  const itemEnd = lastNonBlank >= 0 ? contentSrc[lastNonBlank] + 1 : j;
  return finishListItem(contentLines, refs, endsBlank, itemEnd);
}
function finishListItem(contentLines, refs, endsBlank, end) {
  while (contentLines.length && contentLines[contentLines.length - 1].trim() === '') contentLines.pop();
  const inner = parseBlocks(contentLines, 0, contentLines.length, refs, false, false);
  const text = contentLines.join('\n');
  const taskMatch = /^\[[ xX]\][ \t]+\S/.exec(text);
  let task = false;
  let checked = false;
  let blocks = inner.blocks;
  let blankSep = inner.blankSep;
  if (taskMatch) {
    task = true;
    checked = text.charCodeAt(1) !== 32;
    const stripped = text.replace(/^\[[ xX]\][ \t]+/, '');
    const strippedLines = stripped.split('\n');
    const reparsed = parseBlocks(strippedLines, 0, strippedLines.length, refs, false);
    blocks = reparsed.blocks;
    blankSep = reparsed.blankSep;
  }
  return { blocks, blankSep, endsBlank, task, checked, end };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderBlocks(blocks, cx) {
  let out = '';
  for (const b of blocks) out += renderBlock(b, cx);
  return out;
}
function renderBlock(b, cx) {
  switch (b.t) {
    case 'para':
    case 'text': {
      const inner = scanInline(b.text, 0, b.text.length, cx);
      return '<p>' + inner + '</p>\n';
    }
    case 'heading': {
      const inner = scanInline(b.text, 0, b.text.length, cx);
      return '<h' + b.level + '>' + inner + '</h' + b.level + '>\n';
    }
    case 'hr': return '<hr>\n';
    case 'code': {
      let content = b.text;
      if (content.length > 0) {
        if (content.charCodeAt(content.length - 1) === 10) content = content.slice(0, -1);
        content += '\n';
      }
      const lang = b.lang === '' ? '' : ' class="language-' + escText(b.lang) + '"';
      return '<pre><code' + lang + '>' + escEncode(content) + '</code></pre>\n';
    }
    case 'blockquote': {
      return '<blockquote>\n' + renderBlocks(b.children, cx) + '</blockquote>\n';
    }
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      const start = b.ordered && b.start !== 1 ? ' start="' + b.start + '"' : '';
      let out = '<' + tag + start + '>\n';
      for (const item of b.items) {
        out += '<li>';
        const checkbox = item.task ? '<input' + (item.checked ? ' checked=""' : '') + ' disabled="" type="checkbox"> ' : '';
        if (b.loose) {
          if (checkbox && item.blocks.length > 0 && (item.blocks[0].t === 'text' || item.blocks[0].t === 'para')) {
            // In a loose list the checkbox is the first inline token of
            // the first paragraph, so it renders inside the <p>.
            const first = item.blocks[0];
            const inner = scanInline(first.text, 0, first.text.length, cx);
            out += '<p>' + checkbox + inner + '</p>\n';
            for (let k = 1; k < item.blocks.length; k++) out += renderBlock(item.blocks[k], cx);
          } else {
            if (checkbox) out += '<p>' + checkbox + '</p>\n';
            out += renderBlocks(item.blocks, cx);
          }
        } else {
          if (checkbox) out += checkbox;
          // A tight item: every text/paragraph block renders as its inline
          // content, with no <p> wrapper.
          for (const blk of item.blocks) {
            if (blk.t === 'text' || blk.t === 'para') {
              out += scanInline(blk.text, 0, blk.text.length, cx);
            } else {
              out += renderBlock(blk, cx);
            }
          }
        }
        out += '</li>\n';
      }
      return out + '</' + tag + '>\n';
    }
    case 'html': return b.text;
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let k = 0; k < b.header.length; k++) {
        const align = b.align[k] ? ' align="' + b.align[k] + '"' : '';
        const inner = scanInline(b.header[k], 0, b.header[k].length, cx);
        out += '<th' + align + '>' + inner + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (b.rows.length > 0) {
        out += '<tbody>';
        for (const row of b.rows) {
          out += '<tr>\n';
          for (let k = 0; k < row.length; k++) {
            const align = b.align[k] ? ' align="' + b.align[k] + '"' : '';
            const inner = scanInline(row[k], 0, row[k].length, cx);
            out += '<td' + align + '>' + inner + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      return out + '</table>\n';
    }
  }
  return '';
}

export function parse(markdown) {
  const normalized = markdown.indexOf('\r') === -1 ? markdown : markdown.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  // A trailing newline produces a final empty line that is not a line.
  const endsNl = normalized.length > 0 && normalized.charCodeAt(normalized.length - 1) === 10;
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const refs = new Map();
  const { blocks } = parseBlocks(lines, 0, lines.length, refs, true, endsNl);
  const cx = { refs, plain: false, inLink: false, inRaw: false, hasLink: false };
  return renderBlocks(blocks, cx);
}
