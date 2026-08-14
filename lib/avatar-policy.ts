export const MAX_AVATAR_BYTES = 50 * 1024 * 1024;

export const AVATAR_MIME_KINDS = {
  "image/jpeg": "图片",
  "image/png": "图片",
  "image/webp": "图片",
  "video/mp4": "视频",
  "video/webm": "视频"
} as const;

export const AVATAR_ACCEPT = Object.keys(AVATAR_MIME_KINDS).join(",");

export type AvatarSelection = {
  name: string;
  type: string;
  size: number;
};

export type AvatarSelectionResult =
  | { valid: true; kindLabel: "图片" | "视频" }
  | { valid: false; message: string };

export function classifyAvatarSelection(file: AvatarSelection): AvatarSelectionResult {
  if (file.size === 0) return { valid: false, message: "素材文件不能为空。" };
  if (file.size > MAX_AVATAR_BYTES) return { valid: false, message: "单个素材文件不能超过 50MB。" };
  const kindLabel = AVATAR_MIME_KINDS[file.type as keyof typeof AVATAR_MIME_KINDS];
  if (!kindLabel) {
    return { valid: false, message: "仅支持 JPG、PNG、WebP 图片或 MP4、WebM 视频。" };
  }
  return { valid: true, kindLabel };
}
