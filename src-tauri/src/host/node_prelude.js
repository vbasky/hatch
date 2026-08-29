function hatch(op, payload) {
  return JSON.parse(globalThis.__hatchCall(op, JSON.stringify(payload ?? null)));
}

function bytesFrom(value) {
  if (value == null) return new Uint8Array(0);
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value);
  if (typeof value === "string") return utf8Encode(value);
  return new Uint8Array(0);
}

function utf8Encode(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code < 0x80) out.push(code);
    else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const extra = text.charCodeAt(++i);
      code = 0x10000 + ((code & 0x3ff) << 10) + (extra & 0x3ff);
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    } else {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return Uint8Array.from(out);
}

function utf8Decode(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i++];
    if (b < 0x80) out += String.fromCharCode(b);
    else if ((b & 0xe0) === 0xc0) {
      const c = bytes[i++] & 0x3f;
      out += String.fromCharCode(((b & 0x1f) << 6) | c);
    } else if ((b & 0xf0) === 0xe0) {
      const c = bytes[i++] & 0x3f;
      const d = bytes[i++] & 0x3f;
      out += String.fromCharCode(((b & 0x0f) << 12) | (c << 6) | d);
    } else {
      const c = bytes[i++] & 0x3f;
      const d = bytes[i++] & 0x3f;
      const e = bytes[i++] & 0x3f;
      const code = ((b & 0x07) << 18) | (c << 12) | (d << 6) | e;
      const u = code - 0x10000;
      out += String.fromCharCode(0xd800 + (u >> 10), 0xdc00 + (u & 0x3ff));
    }
  }
  return out;
}

Uint8Array.prototype.readUInt32BE = function readUInt32BE(offset) {
  return (
    ((this[offset] << 24) | (this[offset + 1] << 16) | (this[offset + 2] << 8) | this[offset + 3]) >>> 0
  );
};
Uint8Array.prototype.toString = function toString(encoding) {
  if (encoding && encoding !== "utf8" && encoding !== "utf-8") {
    throw new Error(`unsupported encoding ${encoding}`);
  }
  return utf8Decode(this);
};

globalThis.Buffer = {
  from(data) {
    return bytesFrom(data);
  },
  concat(chunks) {
    let length = 0;
    for (const chunk of chunks) length += chunk.length;
    const out = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  },
};

function EventEmitter() {
  this._l = Object.create(null);
}
EventEmitter.prototype.on = function on(event, fn) {
  (this._l[event] ||= []).push(fn);
  return this;
};
EventEmitter.prototype.emit = function emit(event) {
  const args = Array.prototype.slice.call(arguments, 1);
  const list = this._l[event] || [];
  for (let i = 0; i < list.length; i++) list[i].apply(null, args);
  return this;
};

globalThis.queueMicrotask =
  globalThis.queueMicrotask ||
  function queueMicrotask(fn) {
    Promise.resolve().then(fn);
  };

const timers = new Map();
let nextTimer = 1;
globalThis.setTimeout = function setTimeout(fn, ms) {
  const id = nextTimer++;
  if (!ms) queueMicrotask(fn);
  timers.set(id, fn);
  return id;
};
globalThis.clearTimeout = function clearTimeout(id) {
  timers.delete(id);
};

globalThis.process = {
  env: hatch("env"),
  platform: hatch("platform"),
  getuid() {
    return hatch("getuid");
  },
  kill(pid, signal) {
    const result = hatch("kill", { pid, signal });
    if (result && result.error) {
      const error = new Error(result.error.message);
      error.code = result.error.code;
      throw error;
    }
  },
};

globalThis.__hatchNode = {
  path: {
    join(...parts) {
      return parts.filter((part) => part != null && part !== "").join("/").replace(/\/+/g, "/");
    },
    delimiter: ":",
  },
  os: {
    homedir() {
      return hatch("homedir");
    },
  },
  crypto: {
    createHash(alg) {
      if (alg !== "sha256") throw new Error(`unsupported hash ${alg}`);
      let acc = "";
      return {
        update(value) {
          acc += String(value);
          return this;
        },
        digest() {
          return hatch("sha256", acc);
        },
      };
    },
  },
  fs: {
    constants: { X_OK: 1 },
    readFileSync(filePath, encoding) {
      const result = hatch("readFileSync", String(filePath));
      if (result.error) {
        const error = new Error(result.error.message);
        error.code = result.error.code;
        throw error;
      }
      return encoding === "utf8" || encoding === "utf-8" || encoding == null ? result.text : bytesFrom(result.bytes || []);
    },
    accessSync(filePath, _mode) {
      const result = hatch("accessSync", String(filePath));
      if (result && result.error) {
        const error = new Error(result.error.message);
        error.code = result.error.code;
        throw error;
      }
    },
    statSync(filePath) {
      const result = hatch("statSync", String(filePath));
      if (result.error) {
        const error = new Error(result.error.message);
        error.code = result.error.code;
        throw error;
      }
      return { isFile() { return !!result.isFile; } };
    },
  },
  child_process: {
    spawnSync(command, args, options) {
      const result = hatch("spawnSync", { command: String(command), args: args || [], options: options || {} });
      if (result.error) {
        return { error: Object.assign(new Error(result.error.message), { code: result.error.code }), status: result.status ?? 1, stdout: "", stderr: result.stderr || "" };
      }
      return { status: result.status ?? 0, stdout: result.stdout || "", stderr: result.stderr || "" };
    },
    spawn(command, args, options) {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      const result = hatch("spawn", { command: String(command), args: args || [], options: options || {} });
      child.pid = result.pid;
      queueMicrotask(() => {
        if (result.error) {
          const error = new Error(result.error.message);
          error.code = result.error.code;
          child.emit("error", error);
          child.emit("close", result.status ?? 1);
          return;
        }
        if (result.stdoutBytes && result.stdoutBytes.length) child.stdout.emit("data", bytesFrom(result.stdoutBytes));
        if (result.stderrBytes && result.stderrBytes.length) child.stderr.emit("data", bytesFrom(result.stderrBytes));
        child.emit("close", result.status ?? 0);
      });
      return child;
    },
  },
  https: {
    request(options, callback) {
      const req = new EventEmitter();
      req._chunks = [];
      req._timeout = 0;
      req.setTimeout = function setTimeout(ms, fn) {
        req._timeout = ms;
        if (fn) req.on("timeout", fn);
        return req;
      };
      req.destroy = function destroy() {
        req._destroyed = true;
      };
      req.write = function write(chunk) {
        req._chunks.push(bytesFrom(chunk));
      };
      req.end = function end() {
        if (req._destroyed) return;
        const result = hatch("httpsRequest", {
          hostname: options.hostname,
          path: options.path,
          method: options.method || "GET",
          headers: options.headers || {},
          timeout: req._timeout,
          body: Array.from(globalThis.Buffer.concat(req._chunks)),
        });
        if (result.error) {
          const error = new Error(result.error.message);
          error.code = result.error.code;
          req.emit("error", error);
          return;
        }
        const res = new EventEmitter();
        res.statusCode = result.status;
        res.headers = result.headers || {};
        if (typeof callback === "function") callback(res);
        const body = bytesFrom(result.body || []);
        if (body.length) res.emit("data", body);
        res.emit("end");
      };
      return req;
    },
  },
};
