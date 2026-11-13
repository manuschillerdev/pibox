import { createHash } from "node:crypto";
import { listenerKey, type GuestListener } from "./network-discovery.js";

/** Guest-controlled labels must never emit terminal commands or bidi controls. */
export function cleanNetworkText(text: string): string {
  return [...text].map((c) => {
    const code = c.codePointAt(0)!;
    return code < 32 || (code >= 127 && code <= 159) ||
      (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) ? " " : c;
  }).join("");
}

export function serviceLabel(row: GuestListener): string {
  const d = row.docker;
  return cleanNetworkText(d?.project && d.service ? `${d.project} / ${d.service}` : d?.name || row.process || "Unknown service");
}

function baseName(row: GuestListener): string {
  const d = row.docker;
  return d?.project && d.service ? `${d.project}-${d.service}` : d?.name || `p${row.port}`;
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 8); }
function suffix(base: string, value: string): string { return `${base.slice(0, 39 - value.length).replace(/-+$/, "")}-${value}`; }
function normalizedName(raw: string): string {
  const normalized = raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "service";
  return normalized === raw && normalized.length <= 40 ? normalized : suffix(normalized, hash(raw));
}

/** Defaults only: user-entered and already-published names are never rewritten. */
export function defaultServiceNames(rows: readonly GuestListener[]): Map<string, string> {
  const unique = [...new Map(rows.map((row) => [listenerKey(row), row])).values()];
  const names = new Map(unique.map((row) => [listenerKey(row), normalizedName(baseName(row))]));
  const counts = new Map<string, number>();
  for (const name of names.values()) counts.set(name, (counts.get(name) || 0) + 1);
  for (const row of unique) {
    const key = listenerKey(row), base = names.get(key)!;
    if ((counts.get(base) || 0) > 1) {
      const identity = JSON.stringify([row.docker?.name, row.docker?.replica, row.docker?.containerPort, row.address, row.port]);
      names.set(key, suffix(base, `${row.port}-${hash(identity)}`));
    }
  }
  const used = new Set<string>();
  for (const row of [...unique].sort((a, b) => listenerKey(a).localeCompare(listenerKey(b)))) {
    const key = listenerKey(row), base = names.get(key)!;
    let name = base, attempt = 0;
    while (used.has(name)) name = suffix(base, hash(`${key}\0${attempt++}`));
    names.set(key, name);
    used.add(name);
  }
  return names;
}
