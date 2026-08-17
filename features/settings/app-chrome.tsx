"use client";

import { UserAccountMenu, type AccountPage } from "./user-account-menu";
import { UploadMaterialsDock, type UploadMaterialsDockProps } from "./upload-materials-dock";

export function AppChrome({
  current,
  upload
}: {
  current: AccountPage;
  upload?: UploadMaterialsDockProps;
}) {
  return (
    <>
      {upload ? (
        <div className="uploadDockAnchor">
          <UploadMaterialsDock {...upload} />
        </div>
      ) : null}
      <UserAccountMenu current={current} />
    </>
  );
}
