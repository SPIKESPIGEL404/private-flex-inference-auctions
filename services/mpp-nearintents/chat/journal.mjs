import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { check, digest } from "./config.mjs";

// A process crash leaves the explicit lock in place. Do not expire a lock by
// time and authorize another wallet effect; inspect the original outbox first.
export class FileJournal {
  constructor(directory) {
    this.directory = resolve(directory);
  }
  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    check(
      ((await stat(this.directory)).mode & 0o077) === 0,
      "private_journal_directory_required",
    );
  }
  path(key) {
    return join(this.directory, digest(key) + ".json");
  }
  async get(key) {
    try {
      return JSON.parse(await readFile(this.path(key), "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }
  async list() {
    const files = (await readdir(this.directory)).filter((n) =>
      /^[a-f0-9]{64}\.json$/.test(n),
    );
    return Promise.all(
      files.map((n) =>
        readFile(join(this.directory, n), "utf8").then(JSON.parse),
      ),
    );
  }
  async put(key, value) {
    const path = this.path(key),
      temporary = path + "." + randomUUID();
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, path);
    } catch (e) {
      await unlink(temporary).catch(() => {});
      throw e;
    }
    const dir = await open(this.directory, "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
  async locked(key, fn) {
    const path = this.path(key) + ".lock";
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (e) {
      if (e.code === "EEXIST") throw Error("original_wallet_operation_locked");
      throw e;
    }
    try {
      return await fn();
    } finally {
      await rmdir(path);
    }
  }
}
