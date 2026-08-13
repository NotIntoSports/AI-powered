import type { OBSWebSocket } from "obs-websocket-js";

export const OBS_SCENE_NAME = "AI Digital Human";
export const OBS_STAGE_INPUT_NAME = "AI Digital Human Stage";
export const OBS_HUMAN_MIC_INPUT_NAME = "AI Digital Human Voice";
export const OBS_VIDEO_WIDTH = 1280;
export const OBS_VIDEO_HEIGHT = 720;

export type InterventionAction = "begin" | "end" | "resume" | "mute";

type SceneListResponse = { scenes?: Array<{ sceneName?: string }> };
type InputListResponse = { inputs?: Array<{ inputName?: string }> };
type SceneItemResponse = { sceneItemId: number };

function browserSettings(stageUrl: string) {
  return {
    url: stageUrl,
    width: OBS_VIDEO_WIDTH,
    height: OBS_VIDEO_HEIGHT,
    fps: 30,
    reroute_audio: true,
    shutdown: false,
    restart_when_active: false
  };
}

async function getOrCreateSceneItem(client: OBSWebSocket): Promise<number> {
  try {
    const result = await client.call("GetSceneItemId", {
      sceneName: OBS_SCENE_NAME,
      sourceName: OBS_STAGE_INPUT_NAME
    }) as SceneItemResponse;
    return result.sceneItemId;
  } catch {
    const result = await client.call("CreateSceneItem", {
      sceneName: OBS_SCENE_NAME,
      sourceName: OBS_STAGE_INPUT_NAME,
      sceneItemEnabled: true
    }) as SceneItemResponse;
    return result.sceneItemId;
  }
}

export async function configureManagedObsScene(client: OBSWebSocket, stageUrl: string): Promise<void> {
  const sceneList = await client.call("GetSceneList") as SceneListResponse;
  if (!sceneList.scenes?.some((scene) => scene.sceneName === OBS_SCENE_NAME)) {
    await client.call("CreateScene", { sceneName: OBS_SCENE_NAME });
  }

  const browserInputs = await client.call("GetInputList", { inputKind: "browser_source" }) as InputListResponse;
  const stageInputExists = browserInputs.inputs?.some((input) => input.inputName === OBS_STAGE_INPUT_NAME) ?? false;
  if (!stageInputExists) {
    await client.call("CreateInput", {
      sceneName: OBS_SCENE_NAME,
      inputName: OBS_STAGE_INPUT_NAME,
      inputKind: "browser_source",
      inputSettings: browserSettings(stageUrl),
      sceneItemEnabled: true
    });
  } else {
    await client.call("SetInputSettings", {
      inputName: OBS_STAGE_INPUT_NAME,
      inputSettings: browserSettings(stageUrl),
      overlay: true
    });
  }

  await client.call("SetInputAudioMonitorType", {
    inputName: OBS_STAGE_INPUT_NAME,
    monitorType: "OBS_MONITORING_TYPE_MONITOR_ONLY"
  });

  const audioInputs = await client.call("GetInputList", { inputKind: "wasapi_input_capture" }) as InputListResponse;
  if (!audioInputs.inputs?.some((input) => input.inputName === OBS_HUMAN_MIC_INPUT_NAME)) {
    await client.call("CreateInput", {
      sceneName: OBS_SCENE_NAME,
      inputName: OBS_HUMAN_MIC_INPUT_NAME,
      inputKind: "wasapi_input_capture",
      inputSettings: { device_id: "default" },
      sceneItemEnabled: true
    });
  }
  await client.call("SetInputAudioMonitorType", {
    inputName: OBS_HUMAN_MIC_INPUT_NAME,
    monitorType: "OBS_MONITORING_TYPE_MONITOR_ONLY"
  });
  await client.call("SetInputMute", { inputName: OBS_HUMAN_MIC_INPUT_NAME, inputMuted: true });
  await client.call("SetInputMute", { inputName: OBS_STAGE_INPUT_NAME, inputMuted: false });

  const virtualCamera = await client.call("GetVirtualCamStatus") as { outputActive: boolean };
  if (!virtualCamera.outputActive) {
    await client.call("SetVideoSettings", {
      fpsNumerator: 30,
      fpsDenominator: 1,
      baseWidth: OBS_VIDEO_WIDTH,
      baseHeight: OBS_VIDEO_HEIGHT,
      outputWidth: OBS_VIDEO_WIDTH,
      outputHeight: OBS_VIDEO_HEIGHT
    });
  }

  const sceneItemId = await getOrCreateSceneItem(client);
  await client.call("SetSceneItemTransform", {
    sceneName: OBS_SCENE_NAME,
    sceneItemId,
    sceneItemTransform: {
      positionX: 0,
      positionY: 0,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      cropLeft: 0,
      cropRight: 0,
      cropTop: 0,
      cropBottom: 0,
      boundsType: "OBS_BOUNDS_STRETCH",
      boundsWidth: OBS_VIDEO_WIDTH,
      boundsHeight: OBS_VIDEO_HEIGHT,
      boundsAlignment: 0
    }
  });
  await client.call("SetCurrentProgramScene", { sceneName: OBS_SCENE_NAME });
}

export async function setManagedObsInterventionRouting(
  client: OBSWebSocket,
  action: InterventionAction
): Promise<void> {
  await client.call("SetInputMute", {
    inputName: OBS_HUMAN_MIC_INPUT_NAME,
    inputMuted: action !== "begin"
  });
  await client.call("SetInputMute", {
    inputName: OBS_STAGE_INPUT_NAME,
    inputMuted: action !== "resume"
  });
}
