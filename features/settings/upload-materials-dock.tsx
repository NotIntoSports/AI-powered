"use client";

import { useEffect, useRef } from "react";
import { ResumeUpload } from "../resume/resume-upload";

export type UploadMaterialsDockProps = {
  candidateName: string;
  selectedIds: string[];
  onChangeSelection: (resumeIds: string[]) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function UploadMaterialsDock({
  candidateName,
  selectedIds,
  onChangeSelection,
  open,
  onOpenChange
}: UploadMaterialsDockProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        onOpenChange(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onOpenChange(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onOpenChange]);

  const countLabel = selectedIds.length > 0 ? `（${selectedIds.length}）` : "";

  return (
    <div className="uploadDock" ref={rootRef}>
      <button
        type="button"
        className={`uploadDockTrigger ${open ? "open" : ""}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => onOpenChange(!open)}
      >
        上传资料{countLabel}
      </button>
      {open ? (
        <div className="uploadDockPanel" role="dialog" aria-label="参考资料上传">
          <div className="uploadDockPanelHeader">
            <strong>参考资料</strong>
            <button type="button" className="ghost" onClick={() => onOpenChange(false)}>
              关闭
            </button>
          </div>
          <ResumeUpload
            candidateName={candidateName}
            selectedIds={selectedIds}
            onChangeSelection={onChangeSelection}
            compact
          />
        </div>
      ) : null}
    </div>
  );
}
