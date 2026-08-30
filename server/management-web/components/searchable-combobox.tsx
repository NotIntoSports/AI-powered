"use client";

import { useMemo, useState } from "react";

export type ComboboxOption = {
  value: string;
  label: string;
  keywords?: string;
};

const MAX_VISIBLE = 50;

export function SearchableCombobox({
  options,
  value,
  onChange,
  placeholder = "搜索并选择…",
  disabled = false
}: {
  options: ComboboxOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const selected = options.find((option) => option.value === value);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = !q
      ? options
      : options.filter((option) => {
          const hay = `${option.label} ${option.keywords || ""} ${option.value}`.toLowerCase();
          return hay.includes(q);
        });
    return list;
  }, [options, query]);

  const visible = filtered.slice(0, MAX_VISIBLE);
  const hidden = Math.max(0, filtered.length - visible.length);

  return (
    <div className={`combobox${disabled ? " is-disabled" : ""}`}>
      <input
        value={open && !disabled ? query : selected?.label || ""}
        placeholder={placeholder}
        disabled={disabled}
        onFocus={() => {
          if (disabled) return;
          setOpen(true);
          setQuery("");
        }}
        onChange={(event) => {
          if (disabled) return;
          setOpen(true);
          setQuery(event.target.value);
        }}
        onBlur={() => {
          window.setTimeout(() => setOpen(false), 150);
        }}
        autoComplete="off"
      />
      {open && !disabled ? (
        <ul className="combobox-list">
          {visible.length === 0 ? <li className="muted">无匹配项</li> : null}
          {visible.map((option) => (
            <li key={option.value}>
              <button
                type="button"
                className={option.value === value ? "active" : ""}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                  setQuery("");
                }}
              >
                {option.label}
              </button>
            </li>
          ))}
          {hidden > 0 ? <li className="muted">还有 {hidden} 条，继续输入缩小范围</li> : null}
        </ul>
      ) : null}
      {value && !disabled ? (
        <button
          type="button"
          className="secondary combobox-clear"
          onClick={() => onChange("")}
        >
          清除
        </button>
      ) : null}
    </div>
  );
}
