import { NextRequest, NextResponse } from "next/server";
import { isTrustedMutationRequest } from "./lib/request-origin";

export function middleware(request: NextRequest) {
  const host = request.headers.get("host");
  const targetOrigin = host ? `${request.nextUrl.protocol}//${host}` : request.nextUrl.origin;
  if (isTrustedMutationRequest({
    method: request.method,
    url: request.url,
    headers: request.headers,
    targetOrigin
  })) return NextResponse.next();

  return NextResponse.json(
    {
      code: "CROSS_SITE_REQUEST",
      message: "已拒绝来自其他网站的本机控制请求"
    },
    {
      status: 403,
      headers: {
        "Cache-Control": "no-store",
        "Vary": "Origin, Sec-Fetch-Site"
      }
    }
  );
}

export const config = {
  matcher: "/api/:path*"
};
