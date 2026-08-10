export type VideoDeviceLike = Pick<MediaDeviceInfo, "kind" | "label" | "deviceId">;

export function findObsVirtualCamera(devices: VideoDeviceLike[]) {
  return devices.find((device) => {
    if (device.kind !== "videoinput" || !device.deviceId) return false;
    const label = device.label.trim().toLowerCase();
    return label === "obs virtual camera" ||
      (label.includes("obs") && label.includes("virtual") && label.includes("camera"));
  }) || null;
}

export function stopMediaStream(
  stream: Pick<MediaStream, "getTracks"> | null | undefined
) {
  stream?.getTracks().forEach((track) => track.stop());
}
