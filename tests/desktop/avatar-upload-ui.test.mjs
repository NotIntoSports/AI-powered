import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AVATAR_ACCEPT,
  MAX_AVATAR_BYTES,
  classifyAvatarSelection
} from "../../lib/avatar-policy.ts";

test("avatar policy accepts the five documented image and video formats", () => {
  assert.equal(AVATAR_ACCEPT, "image/jpeg,image/png,image/webp,video/mp4,video/webm");
  assert.equal(MAX_AVATAR_BYTES, 50 * 1024 * 1024);
  assert.deepEqual(classifyAvatarSelection({ name: "portrait.webp", type: "image/webp", size: 1024 }), {
    valid: true,
    kindLabel: "图片"
  });
  assert.deepEqual(classifyAvatarSelection({ name: "idle.mp4", type: "video/mp4", size: 2048 }), {
    valid: true,
    kindLabel: "视频"
  });
});

test("avatar policy rejects unsupported, empty, and oversized selections", () => {
  assert.match(classifyAvatarSelection({ name: "avatar.gif", type: "image/gif", size: 1024 }).message, /JPG.*PNG.*WebP.*MP4.*WebM/);
  assert.match(classifyAvatarSelection({ name: "empty.png", type: "image/png", size: 0 }).message, /不能为空/);
  assert.match(classifyAvatarSelection({ name: "large.mp4", type: "video/mp4", size: MAX_AVATAR_BYTES + 1 }).message, /50MB/);
});

test("settings UI explains avatar requirements and selection feedback", async () => {
  const source = await readFile(new URL("../../app/settings/page.tsx", import.meta.url), "utf8");
  for (const text of ["支持图片 JPG/PNG/WebP，或视频 MP4/WebM；单个文件最大 50MB。", "推荐 16:9、1280×720；视频将静音循环播放；素材仅保存在本机。"]) {
    assert.match(source, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /classifyAvatarSelection/);
  assert.match(source, /disabled=\{uploading \|\| !selectedAvatar\?\.valid\}/);
});
