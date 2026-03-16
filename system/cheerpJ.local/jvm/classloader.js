/**
 * jvm/classloader.js — JAR Parser & Class Loader
 *
 * Loads JAR files (ZIP archives containing .class files) from static paths,
 * parses the class file format, and registers each class with the JVM runtime.
 *
 * JAR loading pipeline:
 *   fetch(jarUrl) → ArrayBuffer → unzip (ZIP parser) → .class entries
 *   → parse ClassFile structure → runtime.registerClass(name, cls)
 */

export class ClassLoader {
  /**
   * @param {object} opts
   * @param {import('./runtime.js').JVMRuntime} opts.runtime
   * @param {function} opts.onLog
   */
  constructor({ runtime, onLog }) {
    this._runtime = runtime;
    this._onLog = onLog;
    this._loaded = new Set();
  }

  /**
   * Load an array of JAR paths into the runtime.
   * @param {string[]} paths
   */
  async loadClasspath(paths) {
    this._onLog(`[ClassLoader] Loading ${paths.length} classpath JARs…`);
    for (const path of paths) {
      await this.loadJar(path);
    }
    this._onLog('[ClassLoader] Classpath loaded.');
  }

  /**
   * Fetch a single JAR, unzip it, and register all classes.
   * @param {string} jarPath
   */
  async loadJar(jarPath) {
    if (this._loaded.has(jarPath)) return;
    this._loaded.add(jarPath);

    let bytes;
    try {
      const resp = await fetch(jarPath);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      bytes = new Uint8Array(await resp.arrayBuffer());
    } catch (err) {
      this._onLog(`[ClassLoader] Could not fetch ${jarPath}: ${err.message}`);
      return;
    }

    const entries = await this._unzip(bytes);
    let count = 0;
    for (const entry of entries) {
      if (entry.name.endsWith('.class')) {
        try {
          const cls = this._parseClassFile(entry.data);
          const name = cls.thisClass || entry.name.replace(/\.class$/, '');
          this._runtime.registerClass(name, cls);
          count++;
        } catch (_) {
          // Skip malformed class files
        }
      }
    }
    this._onLog(`[ClassLoader] ${jarPath.split('/').pop()}: ${count} classes registered.`);
  }

  // ─── ZIP parser ─────────────────────────────────────────────────────────────
  // Minimal ZIP (PKZIP) end-of-central-directory reader.

  async _unzip(bytes) {
    const entries = [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const len = bytes.length;

    // Find end-of-central-directory signature (0x06054b50)
    let eocdOffset = -1;
    for (let i = len - 22; i >= 0; i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset < 0) return entries;

    const cdOffset = view.getUint32(eocdOffset + 16, true);
    const cdEntries = view.getUint16(eocdOffset + 10, true);
    let pos = cdOffset;

    for (let i = 0; i < cdEntries; i++) {
      if (view.getUint32(pos, true) !== 0x02014b50) break;
      const method = view.getUint16(pos + 10, true);
      const compressedSize = view.getUint32(pos + 20, true);
      const uncompressedSize = view.getUint32(pos + 24, true);
      const nameLen = view.getUint16(pos + 28, true);
      const extraLen = view.getUint16(pos + 30, true);
      const commentLen = view.getUint16(pos + 32, true);
      const localOffset = view.getUint32(pos + 42, true);
      const name = new TextDecoder().decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
      pos += 46 + nameLen + extraLen + commentLen;

      // Read local file header
      const lhExtraLen = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + nameLen + lhExtraLen;
      const compData = bytes.subarray(dataStart, dataStart + compressedSize);

      let data;
      if (method === 0) {
        // Stored (no compression)
        data = compData;
      } else if (method === 8) {
        // Deflate — DecompressionStream (async)
        try {
          data = await this._inflate(compData, uncompressedSize);
        } catch (err) {
          this._onLog(`[ClassLoader] Skipping compressed entry "${name}": ${err.message}`);
          continue;
        }
      } else {
        this._onLog(`[ClassLoader] Skipping entry "${name}" — unsupported compression method ${method}`);
        continue;
      }
      entries.push({ name, data });
    }
    return entries;
  }

  /**
   * Inflate (decompress) a raw DEFLATE-compressed byte slice from a ZIP/JAR entry.
   *
   * Uses the browser DecompressionStream API (Chrome 80+, Safari 16.4+,
   * Firefox 113+) which operates on raw deflate *without* the zlib wrapper —
   * ZIP method 8 stores raw deflate.
   *
   * Because DecompressionStream is async, this method must be awaited; callers
   * must use `await this._inflate(...)`.
   *
   * @param {Uint8Array} data           Compressed bytes (raw deflate)
   * @param {number}     expectedSize   Expected uncompressed size (for validation)
   * @returns {Promise<Uint8Array>}
   */
  async _inflate(data, expectedSize) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error(
        'DecompressionStream is not available. ' +
        'Safari 16.4+ / Chrome 80+ / Firefox 113+ required to decompress JAR entries.'
      );
    }
    const ds = new DecompressionStream('raw');
    const writer = ds.writable.getWriter();
    const chunks = [];
    const reader = ds.readable.getReader();

    const readAll = async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    };

    const [, ] = await Promise.all([
      writer.write(data).then(() => writer.close()),
      readAll(),
    ]);

    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  // ─── Class file parser ──────────────────────────────────────────────────────
  // Parses the Java class file format (JVMS §4) to extract the class name,
  // method signatures, and constant pool entries the runtime needs.

  _parseClassFile(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let pos = 0;

    const magic = view.getUint32(pos); pos += 4;
    if (magic !== 0xCAFEBABE) throw new Error('Not a class file');

    const minorVersion = view.getUint16(pos); pos += 2;
    const majorVersion = view.getUint16(pos); pos += 2;

    // Constant pool
    const cpCount = view.getUint16(pos); pos += 2;
    const cp = [null]; // index 0 unused

    for (let i = 1; i < cpCount; i++) {
      const tag = view.getUint8(pos); pos += 1;
      switch (tag) {
        case 1: { // Utf8
          const len = view.getUint16(pos); pos += 2;
          const str = new TextDecoder().decode(bytes.subarray(pos, pos + len)); pos += len;
          cp.push({ tag, value: str });
          break;
        }
        case 7: case 8: { // Class, String
          const idx = view.getUint16(pos); pos += 2;
          cp.push({ tag, index: idx });
          break;
        }
        case 3: case 4: { // Integer, Float
          pos += 4; cp.push({ tag }); break;
        }
        case 5: case 6: { // Long, Double (take 2 slots)
          pos += 8; cp.push({ tag }); cp.push(null); i++; break;
        }
        case 9: case 10: case 11: case 12: { // Field/Method/Interface/NameAndType
          pos += 4; cp.push({ tag }); break;
        }
        case 15: { pos += 3; cp.push({ tag }); break; }
        case 16: { pos += 2; cp.push({ tag }); break; }
        case 18: { pos += 4; cp.push({ tag }); break; }
        default: cp.push({ tag }); break;
      }
    }

    const accessFlags = view.getUint16(pos); pos += 2;
    const thisClassIdx = view.getUint16(pos); pos += 2;
    const superClassIdx = view.getUint16(pos); pos += 2;

    const resolveUtf8 = (cpIdx) => {
      const entry = cp[cpIdx];
      if (!entry) return '';
      if (entry.tag === 1) return entry.value;
      if (entry.tag === 7 || entry.tag === 8) return resolveUtf8(entry.index);
      return '';
    };

    const thisClass = resolveUtf8(thisClassIdx);

    // Skip interfaces, fields — just collect method names for introspection
    const ifaceCount = view.getUint16(pos); pos += 2;
    pos += ifaceCount * 2;

    const fieldCount = view.getUint16(pos); pos += 2;
    for (let i = 0; i < fieldCount; i++) {
      pos += 6;
      const attrCount = view.getUint16(pos); pos += 2;
      for (let a = 0; a < attrCount; a++) {
        pos += 2;
        const alen = view.getUint32(pos); pos += 4 + alen;
      }
    }

    const methodCount = view.getUint16(pos); pos += 2;
    const methods = [];
    for (let i = 0; i < methodCount; i++) {
      const mFlags = view.getUint16(pos); pos += 2;
      const nameIdx = view.getUint16(pos); pos += 2;
      const descIdx = view.getUint16(pos); pos += 2;
      const name = resolveUtf8(nameIdx);
      const descriptor = resolveUtf8(descIdx);
      const attrCount = view.getUint16(pos); pos += 2;
      let bytecode = null;
      for (let a = 0; a < attrCount; a++) {
        const attrNameIdx = view.getUint16(pos); pos += 2;
        const alen = view.getUint32(pos); pos += 4;
        const attrName = resolveUtf8(attrNameIdx);
        if (attrName === 'Code' && alen > 8) {
          // maxStack(2) + maxLocals(2) + codeLen(4) + code...
          const codeLen = view.getUint32(pos + 4);
          bytecode = bytes.slice(pos + 8, pos + 8 + codeLen);
        }
        pos += alen;
      }
      methods.push({ name, descriptor, flags: mFlags, bytecode });
    }

    return {
      thisClass,
      superClass: resolveUtf8(superClassIdx),
      accessFlags,
      majorVersion,
      minorVersion,
      methods,
      constantPool: cp,
    };
  }
}
