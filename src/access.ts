/**
 * Path-based access control inside a team's memory repo.
 *
 *   MEMORY.md, projects/…, people/…   shared team memory      (every member)
 *   private/<member>/…                personal memory          (only that member)
 *   sources/<member>/<date>/<id>.md   raw observations         (only that member; read-only)
 *   .maas/…                           system state             (never visible to agents)
 *
 * Every agent run gets an Access; the repo tools refuse anything outside it.
 */
export const PRIVATE_DIR = "private";
export const SOURCES_DIR = "sources";
export const META_DIR = ".maas";

export type Zone = { kind: "shared" } | { kind: "private"; member: string } | { kind: "source"; member: string } | { kind: "meta" };

export function zoneOf(rel: string): Zone {
  const [top, second] = rel.split("/");
  if (top === META_DIR || top === ".git") return { kind: "meta" };
  if (top === PRIVATE_DIR) return { kind: "private", member: second ?? "" };
  if (top === SOURCES_DIR) return { kind: "source", member: second ?? "" };
  return { kind: "shared" };
}

export interface Access {
  label: string;
  /** Member this run acts for (for private/source zones), if any. */
  member?: string;
  canRead(rel: string): boolean;
  canWrite(rel: string): boolean;
}

/** A member's own agent (ingest/recall): shared + own private, plus own raw sources (read-only). */
export function memberAccess(member: string): Access {
  return {
    label: `member:${member}`,
    member,
    canRead(rel) {
      const z = zoneOf(rel);
      return z.kind === "shared" || ((z.kind === "private" || z.kind === "source") && z.member === member);
    },
    canWrite(rel) {
      const z = zoneOf(rel);
      return z.kind === "shared" || (z.kind === "private" && z.member === member);
    },
  };
}

/** Team dream: only the shared space. Never sees anyone's private memory or raw sources. */
export function sharedDreamAccess(): Access {
  return {
    label: "dream:shared",
    canRead: (rel) => zoneOf(rel).kind === "shared",
    canWrite: (rel) => zoneOf(rel).kind === "shared",
  };
}

/** A member's personal dream: reads shared + own private, writes only own private. */
export function privateDreamAccess(member: string): Access {
  const base = memberAccess(member);
  return {
    label: `dream:private:${member}`,
    member,
    canRead: base.canRead,
    canWrite(rel) {
      const z = zoneOf(rel);
      return z.kind === "private" && z.member === member;
    },
  };
}

export const privateRoot = (member: string) => `${PRIVATE_DIR}/${member}`;
