import crypto from "node:crypto";
import { blobs } from "./storage.js";

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
  /** Optional git remote the team's memory repo is pushed to after each commit. */
  gitRemote?: string;
  members: Member[];
}

export interface Identity {
  team: Team;
  member: Member;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$|^[a-z0-9]$/;

export function validateId(id: string, what: string) {
  if (!ID_RE.test(id)) throw new HttpError(400, `${what} id must be lowercase letters, digits and dashes (1-40 chars): '${id}'`);
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const hash = (key: string) => crypto.createHash("sha256").update(key).digest("hex");
const newKey = () => `maas_${crypto.randomBytes(24).toString("base64url")}`;

/** Teams and member API keys. Small enough to keep in memory; persisted per team in the blob store. */
export class Registry {
  private teams = new Map<string, Team>();
  private byHash = new Map<string, { teamId: string; memberId: string }>();

  async load() {
    for (const key of await blobs.list("registry/teams")) {
      const raw = await blobs.get(key);
      if (!raw) continue;
      const team = JSON.parse(raw.toString("utf8")) as Team;
      this.teams.set(team.id, team);
    }
    this.reindex();
    console.log(`[registry] ${this.teams.size} team(s) loaded`);
  }

  private reindex() {
    this.byHash.clear();
    for (const t of this.teams.values())
      for (const m of t.members) if (!m.revokedAt) this.byHash.set(m.keyHash, { teamId: t.id, memberId: m.id });
  }

  private async save(team: Team) {
    await blobs.put(`registry/teams/${team.id}.json`, JSON.stringify(team, null, 2));
    this.reindex();
  }

  authenticate(key: string): Identity | null {
    const hit = this.byHash.get(hash(key));
    if (!hit) return null;
    const team = this.teams.get(hit.teamId)!;
    const member = team.members.find((m) => m.id === hit.memberId)!;
    return { team, member };
  }

  list(): Team[] {
    return [...this.teams.values()];
  }

  get(teamId: string): Team {
    const t = this.teams.get(teamId);
    if (!t) throw new HttpError(404, `team not found: ${teamId}`);
    return t;
  }

  async createTeam(input: { id: string; name?: string; gitRemote?: string; admin: { id: string; name?: string } }) {
    validateId(input.id, "team");
    if (this.teams.has(input.id)) throw new HttpError(409, `team already exists: ${input.id}`);
    const team: Team = { id: input.id, name: input.name || input.id, createdAt: new Date().toISOString(), gitRemote: input.gitRemote, members: [] };
    this.teams.set(team.id, team);
    const { member, key } = await this.addMember(team.id, { ...input.admin, role: "admin" });
    return { team, member, key };
  }

  async updateTeam(teamId: string, patch: { name?: string; gitRemote?: string | null }) {
    const team = this.get(teamId);
    if (patch.name) team.name = patch.name;
    if (patch.gitRemote !== undefined) team.gitRemote = patch.gitRemote || undefined;
    await this.save(team);
    return team;
  }

  async addMember(teamId: string, input: { id: string; name?: string; role?: Role }) {
    validateId(input.id, "member");
    const team = this.get(teamId);
    const existing = team.members.find((m) => m.id === input.id);
    if (existing && !existing.revokedAt) throw new HttpError(409, `member already exists: ${input.id}`);
    const key = newKey();
    const member: Member = {
      id: input.id,
      name: input.name || input.id,
      role: input.role === "admin" ? "admin" : "member",
      keyHash: hash(key),
      keyPrefix: key.slice(0, 10),
      createdAt: new Date().toISOString(),
    };
    // Re-adding a revoked member keeps their id (and their private memory).
    team.members = team.members.filter((m) => m.id !== input.id).concat(member);
    await this.save(team);
    return { member, key };
  }

  async rotateKey(teamId: string, memberId: string) {
    const team = this.get(teamId);
    const m = team.members.find((x) => x.id === memberId && !x.revokedAt);
    if (!m) throw new HttpError(404, `member not found: ${memberId}`);
    const key = newKey();
    m.keyHash = hash(key);
    m.keyPrefix = key.slice(0, 10);
    await this.save(team);
    return { member: m, key };
  }

  async setRole(teamId: string, memberId: string, role: Role) {
    const team = this.get(teamId);
    const m = team.members.find((x) => x.id === memberId && !x.revokedAt);
    if (!m) throw new HttpError(404, `member not found: ${memberId}`);
    if (m.role === "admin" && role !== "admin" && activeAdmins(team).length <= 1)
      throw new HttpError(400, "a team needs at least one admin");
    m.role = role;
    await this.save(team);
    return m;
  }

  async revoke(teamId: string, memberId: string) {
    const team = this.get(teamId);
    const m = team.members.find((x) => x.id === memberId && !x.revokedAt);
    if (!m) throw new HttpError(404, `member not found: ${memberId}`);
    if (m.role === "admin" && activeAdmins(team).length <= 1) throw new HttpError(400, "can't revoke the last admin");
    m.revokedAt = new Date().toISOString();
    await this.save(team);
    return m;
  }
}

export const activeMembers = (t: Team) => t.members.filter((m) => !m.revokedAt);
const activeAdmins = (t: Team) => activeMembers(t).filter((m) => m.role === "admin");

/** Strip secrets before returning over the API. */
export function publicMember(m: Member) {
  const { keyHash: _, ...rest } = m;
  return rest;
}
export function publicTeam(t: Team) {
  return {
    id: t.id,
    name: t.name,
    createdAt: t.createdAt,
    gitRemote: t.gitRemote ? t.gitRemote.replace(/\/\/[^@/]+@/, "//***@") : undefined,
    members: t.members.map(publicMember),
  };
}

export const registry = new Registry();
