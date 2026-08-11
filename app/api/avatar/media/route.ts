import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { getAvatarMediaPath, getAvatarMetadata } from "../../../../lib/avatar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function mediaHeaders(mimeType: string, size: number) {
  return {
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Length": String(size),
    "Content-Type": mimeType,
    "X-Content-Type-Options": "nosniff"
  };
}

function parseRange(value: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return {
      start: Math.max(0, size - suffixLength),
      end: size - 1
    };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  ) {
    return null;
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

export async function HEAD() {
  const metadata = await getAvatarMetadata();
  if (!metadata.available) return new Response(null, { status: 404 });
  const file = await stat(getAvatarMediaPath());
  return new Response(null, { headers: mediaHeaders(metadata.mimeType, file.size) });
}

export async function GET(request: Request) {
  const metadata = await getAvatarMetadata();
  if (!metadata.available) return new Response("Avatar media not found", { status: 404 });

  const file = await stat(getAvatarMediaPath());
  const range = request.headers.get("range");
  if (!range) {
    const stream = Readable.toWeb(createReadStream(getAvatarMediaPath())) as ReadableStream;
    return new Response(stream, { headers: mediaHeaders(metadata.mimeType, file.size) });
  }

  const parsedRange = parseRange(range, file.size);
  if (!parsedRange) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${file.size}` }
    });
  }

  const { start, end } = parsedRange;
  const length = end - start + 1;
  const stream = Readable.toWeb(createReadStream(getAvatarMediaPath(), { start, end })) as ReadableStream;
  return new Response(stream, {
    status: 206,
    headers: {
      ...mediaHeaders(metadata.mimeType, length),
      "Content-Range": `bytes ${start}-${end}/${file.size}`
    }
  });
}
