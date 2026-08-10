import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const MAX_AVATAR_BYTES = 50 * 1024 * 1024;

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

const avatarDirectory = process.env.INTERVIEW_DATA_DIR
  ? path.join(path.resolve(process.env.INTERVIEW_DATA_DIR), "avatar")
  : path.join(process.cwd(), "data", "avatar");
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
  const format = formats[declaredMimeType as keyof typeof formats];
  if (!format || !format.matches(bytes)) {
    throw new Error("UNSUPPORTED_MEDIA");
  }
  return format;
}

export async function getAvatarMetadata(): Promise<AvatarMetadata | EmptyAvatarMetadata> {
  try {
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as AvatarMetadata;
    await stat(mediaPath);
    return metadata;
  } catch {
    return { available: false };
  }
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
  const temporaryMetadata = path.join(avatarDirectory, `metadata-${metadata.version}.tmp`);
  await writeFile(temporaryMedia, bytes, { flag: "wx" });
  await writeFile(temporaryMetadata, JSON.stringify(metadata, null, 2), { flag: "wx" });
  await rename(temporaryMedia, mediaPath);
  await rename(temporaryMetadata, metadataPath);
  return metadata;
}

export function getAvatarMediaPath() {
  return mediaPath;
}

export async function clearAvatar() {
  await Promise.all([
    rm(mediaPath, { force: true }),
    rm(metadataPath, { force: true })
  ]);
}
