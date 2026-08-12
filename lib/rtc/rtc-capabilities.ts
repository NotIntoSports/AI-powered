export type RtcCapabilities = {
  packageName: string;
  version: string;
  license: string;
  externalPcm: boolean;
  subtitles: boolean;
  electron: boolean;
  redistributable: boolean;
};

export const VOLCENGINE_RTC_CAPABILITIES: RtcCapabilities = Object.freeze({
  packageName: "@volcengine/rtc",
  version: "4.69.0",
  license: "BSD-3-Clause",
  externalPcm: true,
  subtitles: true,
  electron: true,
  redistributable: true
});

export function isRtcReleaseAllowed(capabilities: RtcCapabilities): boolean {
  return capabilities.externalPcm &&
    capabilities.subtitles &&
    capabilities.electron &&
    capabilities.redistributable;
}
