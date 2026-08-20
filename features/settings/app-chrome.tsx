"use client";

import { UserAccountMenu, type AccountPage } from "./user-account-menu";
import { UploadMaterialsDock, type UploadMaterialsDockProps } from "./upload-materials-dock";

export function AppChrome({
  current,
  upload,
  showAccount = true
}: {
  current: AccountPage;
  upload?: UploadMaterialsDockProps;
  showAccount?: boolean;
}) {
  return (
    <>
      {upload ? (
        <div className="uploadDockAnchor">
          <UploadMaterialsDock {...upload} />
        </div>
      ) : null}
      {showAccount ? <UserAccountMenu current={current} /> : null}
    </>
  );
}
