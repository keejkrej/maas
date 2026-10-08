import fs from "node:fs/promises";
import path from "node:path";
import { Storage } from "@google-cloud/storage";
import { config } from "./config.js";

/**
 * Tiny key/value blob store. Used for the inbox journal (so observations survive restarts
 * before the agent has integrated them) and for the git bundle snapshot of the memory repo.
 */
export interface BlobStore {
  readonly kind: "local" | "gcs";
  put(key: string, data: Buffer | string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
  /** Upload a local file (used for large bundles). */
  putFile(key: string, localPath: string): Promise<void>;
  /** Download to a local file; returns false if the key does not exist. */
  getFile(key: string, localPath: string): Promise<boolean>;
}

class LocalBlobStore implements BlobStore {
  readonly kind = "local" as const;
  constructor(private root: string) {}

  private p(key: string) {
    return path.join(this.root, ...key.split("/"));
  }
  async put(key: string, data: Buffer | string) {
    await fs.mkdir(path.dirname(this.p(key)), { recursive: true });
    await fs.writeFile(this.p(key), data);
  }
  async get(key: string) {
    try {
      return await fs.readFile(this.p(key));
    } catch {
      return null;
    }
  }
  async list(prefix: string) {
    const dir = this.p(prefix);
    try {
      const names = await fs.readdir(dir);
      return names.map((n) => `${prefix.replace(/\/$/, "")}/${n}`).sort();
    } catch {
      return [];
    }
  }
  async delete(key: string) {
    await fs.rm(this.p(key), { force: true });
  }
  async putFile(key: string, localPath: string) {
    await fs.mkdir(path.dirname(this.p(key)), { recursive: true });
    await fs.copyFile(localPath, this.p(key));
  }
  async getFile(key: string, localPath: string) {
    try {
      await fs.copyFile(this.p(key), localPath);
      return true;
    } catch {
      return false;
    }
  }
}

class GcsBlobStore implements BlobStore {
  readonly kind = "gcs" as const;
  private bucket;
  constructor(bucketName: string, private prefix: string) {
    this.bucket = new Storage().bucket(bucketName);
  }
  private k(key: string) {
    return `${this.prefix}/${key}`;
  }
  async put(key: string, data: Buffer | string) {
    await this.bucket.file(this.k(key)).save(data, { resumable: false });
  }
  async get(key: string) {
    try {
      const [buf] = await this.bucket.file(this.k(key)).download();
      return buf;
    } catch (e: any) {
      if (e?.code === 404) return null;
      throw e;
    }
  }
  async list(prefix: string) {
    const full = this.k(prefix.replace(/\/?$/, "/"));
    const [files] = await this.bucket.getFiles({ prefix: full });
    return files.map((f) => f.name.slice(this.prefix.length + 1)).sort();
  }
  async delete(key: string) {
    await this.bucket.file(this.k(key)).delete({ ignoreNotFound: true });
  }
  async putFile(key: string, localPath: string) {
    await this.bucket.upload(localPath, { destination: this.k(key), resumable: false });
  }
  async getFile(key: string, localPath: string) {
    const f = this.bucket.file(this.k(key));
    const [exists] = await f.exists();
    if (!exists) return false;
    await f.download({ destination: localPath });
    return true;
  }
}

export const blobs: BlobStore = config.gcsBucket
  ? new GcsBlobStore(config.gcsBucket, config.gcsPrefix)
  : new LocalBlobStore(config.stateDir);
