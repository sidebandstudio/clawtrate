// The saved picture: a 128 px PNG of the still pose with the choice in one
// tEXt chunk (docs/design/avatar-studio.md, section 5). Not product code.
//
// Two readers live here. `readPictureV1` is a pinned copy of the strict
// reader in draft PR #300 (packages/core/src/avatar.ts at 59aeea0a, types
// stripped; b4a65fe0 only rewrites the bit-depth table as a function, with
// the same answers): what an older Clawtrate does with a picture. `readPicture` is
// the proposed reader, which knows both keywords. The checks run real PNG
// bytes through both.

(function () {
  const C = window.ClawtrateCreatures;
  const A = window.ClawtrateAccessories;

  /** Version 1, unchanged: a choice with nothing worn. */
  const KEYWORD_V1 = "clawtrate-avatar";
  /** Version 2: a choice wearing something. A strict version 1 reader doesn't know it and shows the picture. */
  const KEYWORD_V2 = "clawtrate-avatar-v2";
  const MAX_PICTURE_CHARS = 32768;
  const MAX_CHOICE_CHARS = 200;
  const MAX_PNG_CHUNKS = 128;
  const MAX_PNG_SIDE = 8192;
  const PNG_PREFIX = "data:image/png;base64,";
  const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytesOf = (text) => [...text].map((ch) => ch.charCodeAt(0));

  // Pinned from #300 ------------------------------------------------------------------

  function fromBase64(text) {
    if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) return null;
    const clean = text.replace(/=+$/, "");
    const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
    let bits = 0;
    let value = 0;
    let at = 0;
    for (const char of clean) {
      value = ((value << 6) | B64.indexOf(char)) & 0xffffff;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[at++] = (value >> bits) & 0xff;
      }
    }
    if (bits > 0 && (value & ((1 << bits) - 1)) !== 0) return null;
    return out.subarray(0, at);
  }

  function toBase64(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
      out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=";
      out += i + 2 < bytes.length ? B64[n & 63] : "=";
    }
    return out;
  }

  let crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
      }
    }
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  const u32 = (bytes, at) => ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
  const isLetter = (byte) => (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122);
  const DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

  /** #300's well-formed PNG: lengths, CRCs, IHDR first, one IDAT run, IEND last with nothing after it. */
  function pngChunks(bytes) {
    if (bytes.length < 8 || PNG_SIGNATURE.some((byte, i) => bytes[i] !== byte)) return null;
    const chunks = [];
    let at = 8;
    let idat = "before";
    let palette = false;
    while (at < bytes.length) {
      if (chunks.length >= MAX_PNG_CHUNKS || at + 12 > bytes.length) return null;
      const length = u32(bytes, at);
      const end = at + 12 + length;
      if (length > bytes.length || end > bytes.length) return null;
      const typeBytes = bytes.subarray(at + 4, at + 8);
      if (!typeBytes.every(isLetter) || (typeBytes[2] & 0x20) !== 0) return null;
      if (crc32(bytes.subarray(at + 4, at + 8 + length)) !== u32(bytes, at + 8 + length)) return null;
      const type = String.fromCharCode(...typeBytes);
      const data = bytes.subarray(at + 8, at + 8 + length);
      const critical = (typeBytes[0] & 0x20) === 0;
      if (chunks.length === 0 && type !== "IHDR") return null;
      if (type === "IHDR") {
        if (chunks.length !== 0 || length !== 13) return null;
        const width = u32(data, 0);
        const height = u32(data, 4);
        const [depth, colour, compression, filter, interlace] = data.subarray(8);
        if (width < 1 || height < 1 || width > MAX_PNG_SIDE || height > MAX_PNG_SIDE) return null;
        if (!DEPTHS[colour]?.includes(depth) || compression !== 0 || filter !== 0) return null;
        if (interlace !== 0 && interlace !== 1) return null;
      } else if (type === "PLTE") {
        if (palette || idat !== "before" || length === 0 || length % 3 !== 0) return null;
        palette = true;
      } else if (type === "IDAT") {
        if (idat === "after") return null;
        idat = "in";
      } else if (type === "IEND") {
        if (length !== 0 || idat === "before" || end !== bytes.length) return null;
        chunks.push({ type, start: at, end, data });
        return chunks;
      } else if (critical) return null;
      if (type !== "IDAT" && idat === "in") idat = "after";
      chunks.push({ type, start: at, end, data });
      at = end;
    }
    return null;
  }

  /** A tEXt chunk under exactly this keyword: its bytes, then the NUL at its exact length. */
  function isTagged(chunk, keyword) {
    const key = bytesOf(keyword);
    return chunk.type === "tEXt" && chunk.data.length > key.length && key.every((byte, i) => chunk.data[i] === byte) && chunk.data[key.length] === 0;
  }

  /**
   * A tEXt chunk that starts with the reserved version 2 keyword and has no
   * separator at all: not a picture's own text, but a broken tag. Version 1's
   * keyword keeps #300's reading (such a chunk is ignored there).
   */
  function isBrokenV2(chunk) {
    const key = bytesOf(KEYWORD_V2);
    return chunk.type === "tEXt" && chunk.data.length >= key.length && key.every((byte, i) => chunk.data[i] === byte) && chunk.data.indexOf(0) < 0;
  }

  /** The text after the keyword: 1 to 200 printable ASCII bytes, or null. */
  function choiceText(chunk, keyword) {
    const value = chunk.data.subarray(keyword.length + 1);
    if (value.length === 0 || value.length > MAX_CHOICE_CHARS) return null;
    let text = "";
    for (const byte of value) {
      if (byte < 0x20 || byte > 0x7e) return null;
      text += String.fromCharCode(byte);
    }
    return text;
  }

  /** #300's strict version 1 text reader. */
  function decodeV1(text) {
    if (text.length > MAX_CHOICE_CHARS) return null;
    const fields = Object.create(null);
    const pairs = text.split("&");
    if (pairs.length > 6) return null;
    for (const pair of pairs) {
      const at = pair.indexOf("=");
      if (at <= 0) return null;
      const key = pair.slice(0, at);
      if (Object.prototype.hasOwnProperty.call(fields, key)) return null;
      fields[key] = pair.slice(at + 1);
    }
    if (fields.v !== "1") return null;
    delete fields.v;
    return A.parseBase(fields);
  }

  function readPng(url) {
    if (typeof url !== "string" || url.length > MAX_PICTURE_CHARS || !url.startsWith(PNG_PREFIX)) return null;
    const bytes = fromBase64(url.slice(PNG_PREFIX.length));
    const chunks = bytes && pngChunks(bytes);
    return bytes && chunks ? { bytes, chunks } : null;
  }

  /** The pinned #300 reader: plain, creature (version 1), or invalid. */
  function readPictureV1(url) {
    const png = readPng(url);
    if (!png) return { kind: "invalid" };
    const marked = png.chunks.filter((c) => isTagged(c, KEYWORD_V1));
    if (marked.length === 0) return { kind: "plain" };
    if (marked.length > 1) return { kind: "invalid" };
    const text = choiceText(marked[0], KEYWORD_V1);
    const choice = text === null ? null : decodeV1(text);
    return choice ? { kind: "creature", choice } : { kind: "invalid" };
  }

  // Proposed --------------------------------------------------------------------------

  /**
   * The proposed reader. No recognized tag: a plain picture. Exactly one: the
   * version 1 tag read by #300's rules, or the version 2 tag by its grammar.
   * Two recognized tags, both keywords together, or a tag that doesn't parse:
   * invalid, so the bot gets its id's Clawling as #300 does.
   */
  function readPicture(url) {
    const png = readPng(url);
    if (!png) return { kind: "invalid" };
    const v1 = png.chunks.filter((c) => isTagged(c, KEYWORD_V1));
    const v2 = png.chunks.filter((c) => isTagged(c, KEYWORD_V2));
    if (png.chunks.some(isBrokenV2)) return { kind: "invalid" };
    if (v1.length + v2.length === 0) return { kind: "plain" };
    if (v1.length + v2.length > 1) return { kind: "invalid" };
    const keyword = v1.length ? KEYWORD_V1 : KEYWORD_V2;
    const text = choiceText(v1[0] || v2[0], keyword);
    const choice = text === null ? null : v1.length ? decodeV1(text) : A.decodeV2(text);
    return choice ? { kind: "creature", choice, version: v1.length ? 1 : 2 } : { kind: "invalid" };
  }

  /** A tEXt chunk's bytes: length, type, keyword, NUL, text, CRC. */
  function textChunk(keyword, text) {
    const payload = `${keyword}\0${text}`;
    const body = new Uint8Array(4 + payload.length);
    body.set([0x74, 0x45, 0x58, 0x74], 0);
    for (let i = 0; i < payload.length; i++) body[4 + i] = payload.charCodeAt(i);
    const chunk = new Uint8Array(12 + payload.length);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, payload.length);
    chunk.set(body, 4);
    view.setUint32(8 + payload.length, crc32(body));
    return chunk;
  }

  /** Chunks back into a PNG data URL, with `extra` just after IHDR. */
  function assemble(bytes, chunks, extra) {
    const parts = [bytes.subarray(0, 8), bytes.subarray(chunks[0].start, chunks[0].end), ...extra];
    for (const each of chunks.slice(1)) parts.push(bytes.subarray(each.start, each.end));
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return PNG_PREFIX + toBase64(out);
  }

  /**
   * The picture with the choice written into it: one tag, just after IHDR,
   * replacing any tag under either keyword. Version 1 bytes under the old
   * keyword when nothing is worn; version 2 under the new one when anything
   * is. Null when the result would pass 128 chunks or 32,768 characters.
   */
  function pictureWithChoice(url, choice) {
    const png = readPng(url);
    if (!png) return null;
    const kept = png.chunks.filter((c) => !isTagged(c, KEYWORD_V1) && !isTagged(c, KEYWORD_V2) && !isBrokenV2(c));
    // The tag is one more chunk: the result must stay within #300's 128.
    if (kept.length + 1 > MAX_PNG_CHUNKS) return null;
    const tag = A.wears(choice) ? textChunk(KEYWORD_V2, A.encodeChoice(choice)) : textChunk(KEYWORD_V1, C.encodeAvatarChoice(choice));
    const result = assemble(png.bytes, kept, [tag]);
    return result.length <= MAX_PICTURE_CHARS ? result : null;
  }

  /** For the checks: any chunks inserted after IHDR, CRCs computed, nothing else touched. */
  function withChunks(url, list) {
    const png = readPng(url);
    if (!png) return null;
    return assemble(png.bytes, png.chunks, list.map(([keyword, text]) => (text === null ? rawText(keyword) : textChunk(keyword, text))));
  }

  /** A tEXt chunk of exactly these bytes, with no separator: for the checks' broken tags. */
  function rawText(bytes) {
    const body = new Uint8Array(4 + bytes.length);
    body.set([0x74, 0x45, 0x58, 0x74], 0);
    for (let i = 0; i < bytes.length; i++) body[4 + i] = bytes.charCodeAt(i);
    const chunk = new Uint8Array(12 + bytes.length);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, bytes.length);
    chunk.set(body, 4);
    view.setUint32(8 + bytes.length, crc32(body));
    return chunk;
  }

  /** How many chunks a picture has, for the checks. */
  const chunkCount = (url) => readPng(url)?.chunks.length ?? null;

  /** The tags a picture carries, as [keyword, text], for the checks and the board. */
  function tags(url) {
    const png = readPng(url);
    if (!png) return null;
    return png.chunks
      .filter((c) => c.type === "tEXt")
      .map((c) => {
        const zero = c.data.indexOf(0);
        return [String.fromCharCode(...c.data.subarray(0, zero)), String.fromCharCode(...c.data.subarray(zero + 1))];
      });
  }

  /**
   * The still pose at 128 px, drawn the way the live Claw is (the same scene,
   * sockets and fit), then tagged. `svg` is the creature's SVG markup.
   */
  function stillPicture(svg, choice, px = 128) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = px;
        canvas.height = px;
        canvas.getContext("2d").drawImage(img, 0, 0, px, px);
        resolve(pictureWithChoice(canvas.toDataURL("image/png"), choice));
      };
      img.onerror = () => resolve(null);
      const sized = svg.replace("<svg ", `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" `);
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized)}`;
    });
  }

  window.ClawtratePicture = {
    KEYWORD_V1,
    KEYWORD_V2,
    MAX_PICTURE_CHARS,
    readPictureV1,
    readPicture,
    pictureWithChoice,
    withChunks,
    chunkCount,
    tags,
    stillPicture,
  };
})();
