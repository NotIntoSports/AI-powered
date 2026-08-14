import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataRoot, getDatabase, hasMigration, runTransaction } from "./database";
import { AVATAR_MIME_KINDS, MAX_AVATAR_BYTES } from "./avatar-policy";

export { MAX_AVATAR_BYTES } from "./avatar-policy";

export type AvatarKind = "image" | "video";

export type AvatarMetadata = {
  available: true;
  kind: AvatarKind;
  mimeType: string;
  originalName: string;
  size: number;
  version: string;
  updatedAt: string;
};

export type EmptyAvatarMetadata = {
  available: false;
};

const avatarDirectory = path.join(dataRoot, "avatar");
const mediaPath = path.join(avatarDirectory, "media");
const metadataPath = path.join(avatarDirectory, "metadata.json");

const formats = {
  "image/jpeg": { kind: "image" as const, matches: (bytes: Uint8Array) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  "image/png": { kind: "image" as const, matches: (bytes: Uint8Array) => bytes.slice(0, 8).every((value, index) => value === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][index]) },
  "image/webp": { kind: "image" as const, matches: (bytes: Uint8Array) => text(bytes, 0, 4) === "RIFF" && text(bytes, 8, 12) === "WEBP" },
  "video/mp4": { kind: "video" as const, matches: (bytes: Uint8Array) => text(bytes, 4, 8) === "ftyp" },
  "video/webm": { kind: "video" as const, matches: (bytes: Uint8Array) => bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3 }
};

function text(bytes: Uint8Array, start: number, end: number) {
  return String.fromCharCode(...bytes.slice(start, end));
}

export function validateAvatar(bytes: Uint8Array, declaredMimeType: string) {
  if (!(declaredMimeType in AVATAR_MIME_KINDS)) throw new Error("UNSUPPORTED_MEDIA");
  const format = formats[declaredMimeType as keyof typeof formats];
  if (!format || !format.matches(bytes)) {
    throw new Error("UNSUPPORTED_MEDIA");
  }
  return format;
}

export async function getAvatarMetadata(): Promise<AvatarMetadata | EmptyAvatarMetadata> {
  await migrateLegacyAvatarMetadata();
  try {
    const row = getDatabase().prepare(
      "SELECT payload FROM avatar_metadata WHERE singleton_id = 1"
    ).get() as { payload: string } | undefined;
    if (!row) return { available: false };
    const metadata = JSON.parse(row.payload) as AvatarMetadata;
    await stat(mediaPath);
    return metadata;
  } catch {
    return { available: false };
  }
}

async function migrateLegacyAvatarMetadata() {
  if (hasMigration("avatar-json")) return;
  let metadata: AvatarMetadata | null = null;
  try {
    const parsed = JSON.parse(await readFile(metadataPath, "utf8")) as AvatarMetadata;
    await stat(mediaPath);
    if (parsed.available === true && typeof parsed.version === "string") metadata = parsed;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("Legacy avatar metadata was invalid and was not imported.");
    }
  }
  runTransaction(() => {
    const timestamp = new Date().toISOString();
    if (metadata) {
      getDatabase().prepare(`
        INSERT INTO avatar_metadata(singleton_id, payload, updated_at) VALUES (1, ?, ?)
        ON CONFLICT(singleton_id) DO NOTHING
      `).run(JSON.stringify(metadata), timestamp);
    }
    getDatabase().prepare(`
      INSERT INTO app_settings(key, value, updated_at) VALUES (?, 'complete', ?)
      ON CONFLICT(key) DO UPDATE SET value = 'complete', updated_at = excluded.updated_at
    `).run("migration:avatar-json", timestamp);
  });
}

export async function saveAvatar(file: File): Promise<AvatarMetadata> {
  if (file.size === 0 || file.size > MAX_AVATAR_BYTES) {
    throw new Error("INVALID_SIZE");
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const format = validateAvatar(bytes, file.type);
  const metadata: AvatarMetadata = {
    available: true,
    kind: format.kind,
    mimeType: file.type,
    originalName: file.name.slice(0, 150),
    size: file.size,
    version: crypto.randomUUID(),
    updatedAt: new Date().toISOString()
  };

  await mkdir(avatarDirectory, { recursive: true });
  const temporaryMedia = path.join(avatarDirectory, `media-${metadata.version}.tmp`);
  await writeFile(temporaryMedia, bytes, { flag: "wx" });
  await rename(temporaryMedia, mediaPath);
  getDatabase().prepare(`
    INSERT INTO avatar_metadata(singleton_id, payload, updated_at) VALUES (1, ?, ?)
    ON CONFLICT(singleton_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
  `).run(JSON.stringify(metadata), metadata.updatedAt);
  return metadata;
}

export function getAvatarMediaPath() {
  return mediaPath;
}

export async function clearAvatar() {
  getDatabase().prepare("DELETE FROM avatar_metadata WHERE singleton_id = 1").run();
  await rm(mediaPath, { force: true });
}
