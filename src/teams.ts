import crypto from "node:crypto";
import { db } from "./db.js";

export type Role = "admin" | "member";

export interface Member {
  id: string;
  name: string;
  role: Role;
  /** sha256 of the API key; the key itself is only shown once. */
  keyHash: string;
  /** First chars of the key, to help people tell keys apart. */
  keyPrefix: string;
  createdAt: string;
  revokedAt?: string;
}

export interface Team {
  id: string;
  name: string;
  createdAt: string;
  members: Member[];
}

export interface Identity {
  team: Team;
  member: Member;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const ID_RE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
export function validateId(id: string, what: string) {
  if (!ID_RE.test(id ?? "")) throw new HttpError(400, `${what} id must be lowercase letters, digits and dashes (1-40 chars): '${id}'`);
}

const hash = (key: string) => crypto.createHash("sha256").update(key).digest("hex");
const newKey = () => `maas_${crypto.randomBytes(24).toString("base64url")}`;
const teamPath = (id: string) => `teams/${id}`;
const keyPath = (h: string) => `keys/${h}`;

export const activeMembers = (t: Team) => t.members.filter((m) => !m.revokedAt);
const activeAdmins = (t: Team) => activeMembers(t).filter((m) => m.role === "admin");

/**
 * Teams and member API keys, stored in Firestore (`teams/{id}`, `keys/{sha256}`).
 * Serverless instances cache team docs briefly; revocations propagate within CACHE_MS.
 */
const CACHE_MS = 15_000;

export class Registry {
  private cache = new Map<string, { at: number; team: Team }>();
  private keyCache = new Map<string, { at: number; teamId: string; memberId: string } | { at: number; miss: true }>();

  private remember(team: Team) {
    this.cache.set(team.id, { at: Date.now(), team });
    return team;
  }

  async find(teamId: string): Promise<Team | null> {
    const c = this.cache.get(teamId);
    if (c && Date.now() - c.at < CACHE_MS) return c.team;
    const t = await db.get<Team>(teamPath(teamId));
    if (t) this.remember(t);
    return t;
  }

  async get(teamId: string): Promise<Team> {
    const t = await this.find(teamId);
    if (!t) throw new HttpError(404, `team not found: ${teamId}`);
    return t;
  }

  async list(): Promise<Team[]> {
    return (await db.list<Team>("teams")).map((r) => this.remember(r.data));
  }

  async authenticate(key: string): Promise<Identity | null> {
    if (!key?.startsWith("maas_")) return null;
    const h = hash(key);
    let k = this.keyCache.get(h);
    if (!k || Date.now() - k.at > CACHE_MS) {
      const doc = await db.get<{ teamId: string; memberId: string }>(keyPath(h));
      k = doc ? { at: Date.now(), ...doc } : { at: Date.now(), miss: true };
      this.keyCache.set(h, k);
    }
    if ("miss" in k) return null;
    const team = await this.find(k.teamId);
    const member = team?.members.find((m) => m.id === k.memberId && m.keyHash === h && !m.revokedAt);
    return team && member ? { team, member } : null;
  }

  /** Transactionally mutate a team doc. */
  private async mutate(teamId: string, fn: (t: Team) => void): Promise<Team> {
    const out = await db.update<Team>(teamPath(teamId), (cur) => {
      if (!cur) throw new HttpError(404, `team not found: ${teamId}`);
      fn(cur);
      return cur;
    });
    return this.remember(out!);
  }

  async createTeam(input: { id: string; name?: string; admin: { id: string; name?: string } }) {
    validateId(input.id, "team");
    validateId(input.admin?.id, "member");
    const team: Team = { id: input.id, name: input.name || input.id, createdAt: new Date().toISOString(), members: [] };
    await db.update<Team>(teamPath(team.id), (cur) => {
      if (cur) throw new HttpError(409, `team already exists: ${team.id}`);
      return team;
    });
    const { member, key } = await this.addMember(team.id, { ...input.admin, role: "admin" });
    return { team: await this.get(team.id), member, key };
  }

  async updateTeam(teamId: string, patch: { name?: string }) {
    return this.mutate(teamId, (t) => {
      if (patch.name) t.name = patch.name;
    });
  }

  async addMember(teamId: string, input: { id: string; name?: string; role?: Role }) {
    validateId(input.id, "member");
    const key = newKey();
    const member: Member = {
      id: input.id,
      name: input.name || input.id,
      role: input.role === "admin" ? "admin" : "member",
      keyHash: hash(key),
      keyPrefix: key.slice(0, 10),
      createdAt: new Date().toISOString(),
    };
    let oldHash: string | undefined;
    await this.mutate(teamId, (t) => {
      const existing = t.members.find((m) => m.id === input.id);
      if (existing && !existing.revokedAt) throw new HttpError(409, `member already exists: ${input.id}`);
      oldHash = existing?.keyHash;
      // Re-adding a revoked member keeps their id (and their private memory).
      t.members = t.members.filter((m) => m.id !== input.id).concat(member);
    });
    await db.batch([
      ...(oldHash ? [{ op: "delete" as const, path: keyPath(oldHash) }] : []),
      { op: "set", path: keyPath(member.keyHash), data: { teamId, memberId: member.id } },
    ]);
    return { member, key };
  }

  async rotateKey(teamId: string, memberId: string) {
    const key = newKey();
    let oldHash = "";
    let member!: Member;
    await this.mutate(teamId, (t) => {
      const m = t.members.find((x) => x.id === memberId && !x.revokedAt);
      if (!m) throw new HttpError(404, `member not found: ${memberId}`);
      oldHash = m.keyHash;
      m.keyHash = hash(key);
      m.keyPrefix = key.slice(0, 10);
      member = m;
    });
    this.keyCache.delete(oldHash);
    await db.batch([
      { op: "delete", path: keyPath(oldHash) },
      { op: "set", path: keyPath(member.keyHash), data: { teamId, memberId } },
    ]);
    return { member, key };
  }

  async setRole(teamId: string, memberId: string, role: Role) {
    let member!: Member;
    await this.mutate(teamId, (t) => {
      const m = t.members.find((x) => x.id === memberId && !x.revokedAt);
      if (!m) throw new HttpError(404, `member not found: ${memberId}`);
      if (m.role === "admin" && role !== "admin" && activeAdmins(t).length <= 1) throw new HttpError(400, "a team needs at least one admin");
      m.role = role;
      member = m;
    });
    return member;
  }

  async revoke(teamId: string, memberId: string) {
    let member!: Member;
    await this.mutate(teamId, (t) => {
      const m = t.members.find((x) => x.id === memberId && !x.revokedAt);
      if (!m) throw new HttpError(404, `member not found: ${memberId}`);
      if (m.role === "admin" && activeAdmins(t).length <= 1) throw new HttpError(400, "can't revoke the last admin");
      m.revokedAt = new Date().toISOString();
      member = m;
    });
    this.keyCache.delete(member.keyHash);
    await db.delete(keyPath(member.keyHash));
    return member;
  }
}

/** Strip secrets before returning over the API. */
export function publicMember(m: Member) {
  const { keyHash: _, ...rest } = m;
  return rest;
}
export function publicTeam(t: Team) {
  return { id: t.id, name: t.name, createdAt: t.createdAt, members: t.members.map(publicMember) };
}

export const registry = new Registry();
