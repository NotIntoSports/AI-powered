"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { parseAPIError, publicUserFromUnknown, requestJSON, type PublicUser } from "../lib/control-api";

export function useAdminSession() {
  const router = useRouter();
  const [me, setMe] = useState<PublicUser | null>(null);
  const [error, setError] = useState("");

  async function refresh() {
    const meResult = await requestJSON("/api/v1/auth/me");
    if (meResult.response.status === 401) {
      router.replace("/login");
      return null;
    }
    const current = publicUserFromUnknown(meResult.body);
    if (!current || current.role !== "admin") {
      setError("需要管理员账号才能进入管理后台");
      setMe(current);
      return null;
    }
    setMe(current);
    return current;
  }

  useEffect(() => {
    void refresh();
  }, []);

  return { me, error, setError, refresh, parseAPIError };
}
