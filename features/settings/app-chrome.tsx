"use client";

import { UserAccountMenu, type AccountPage } from "./user-account-menu";
import { UploadMaterialsDock, type UploadMaterialsDockProps } from "./upload-materials-dock";
import { AutoBridgeController } from "../rtc/auto-bridge-controller";

export function AppChrome({
  current,
  upload
}: {
  current: AccountPage;
  upload?: UploadMaterialsDockProps;
}) {
  return (
    <>
      <AutoBridgeController />
      {upload ? (
        <div className="uploadDockAnchor">
          <UploadMaterialsDock {...upload} />
        </div>
      ) : null}
      <UserAccountMenu current={current} />
    </>
  );
}
