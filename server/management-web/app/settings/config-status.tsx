"use client";

import type { ChangeEvent } from "react";

export function ConfigStatus({ ready, readyText, waitText }: { ready: boolean; readyText: string; waitText: string }) {
  return <p className={ready ? "status-pill ok-pill" : "status-pill wait-pill"}>{ready ? readyText : waitText}</p>;
}

export function SecretField({
  label,
  configured,
  value,
  onChange
}: {
  label: string;
  configured: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      {label}{configured ? "（已保存，留空则保留）" : ""}
      <input
        type="password"
        value={value}
        placeholder={configured ? "••••••••  已保存，无需再填" : ""}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
        autoComplete="new-password"
      />
    </label>
  );
}
