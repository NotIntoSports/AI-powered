export const OBS_SCENE_NAME = "AI Interviewer";
export const OBS_INPUT_NAME = "AI Interviewer Stage";
export const OBS_HUMAN_MIC_NAME = "AI Interviewer Human Mic";
export const OBS_WIDTH = 1280;
export const OBS_HEIGHT = 720;

export type ObsCallClient = {
  call(requestType: string, requestData?: Record<string, unknown>): Promise<unknown>;
};

type SceneListResponse = {
  scenes?: Array<{ sceneName?: string }>;
};

type InputListResponse = {
  inputs?: Array<{ inputName?: string; inputKind?: string }>;
};

type SceneItemResponse = {
  sceneItemId: number;
};

type VirtualCameraResponse = {
  outputActive: boolean;
};

export type ObsSetupResult = {
  sceneCreated: boolean;
  inputCreated: boolean;
  audioMonitoringEnabled: boolean;
  virtualCameraStarted: boolean;
  humanMicReady: boolean;
};

export type InterventionAction = "begin" | "end" | "resume" | "mute";

export async function setInterventionRouting(client: ObsCallClient, action: InterventionAction) {
  const humanSpeaking = action === "begin";
  const aiSpeaking = action === "resume";
  await client.call("SetInputMute", { inputName: OBS_HUMAN_MIC_NAME, inputMuted: !humanSpeaking });
  await client.call("SetInputMute", { inputName: OBS_INPUT_NAME, inputMuted: !aiSpeaking });
}

export async function retryUntilSuccess(
  operation: () => Promise<boolean>,
  options: {
    attempts: number;
    delayMs: number;
    isCancelled?: () => boolean;
    onRetry?: (completedAttempts: number) => void;
  }
) {
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    if (options.isCancelled?.()) return false;
    try {
      if (await operation()) return true;
    } catch {
      // A cold-start connection can fail until OBS finishes loading.
    }
    if (attempt === options.attempts || options.isCancelled?.()) break;
    options.onRetry?.(attempt);
    await new Promise((resolve) => setTimeout(resolve, options.delayMs));
  }
  return false;
}

function browserSettings(stageUrl: string) {
  return {
    url: stageUrl,
    width: OBS_WIDTH,
    height: OBS_HEIGHT,
    fps: 30,
    reroute_audio: true,
    shutdown: false,
    restart_when_active: false
  };
}

async function getOrCreateSceneItem(client: ObsCallClient, inputCreated: boolean) {
  if (inputCreated) {
    const result = await client.call("GetSceneItemId", {
      sceneName: OBS_SCENE_NAME,
      sourceName: OBS_INPUT_NAME
    }) as SceneItemResponse;
    return result.sceneItemId;
  }

  try {
    const result = await client.call("GetSceneItemId", {
      sceneName: OBS_SCENE_NAME,
      sourceName: OBS_INPUT_NAME
    }) as SceneItemResponse;
    return result.sceneItemId;
  } catch {
    const result = await client.call("CreateSceneItem", {
      sceneName: OBS_SCENE_NAME,
      sourceName: OBS_INPUT_NAME,
      sceneItemEnabled: true
    }) as SceneItemResponse;
    return result.sceneItemId;
  }
}

export async function configureObs(
  client: ObsCallClient,
  stageUrl: string
): Promise<ObsSetupResult> {
  const scenes = await client.call("GetSceneList") as SceneListResponse;
  const sceneExists = scenes.scenes?.some((scene) => scene.sceneName === OBS_SCENE_NAME) ?? false;
  if (!sceneExists) {
    await client.call("CreateScene", { sceneName: OBS_SCENE_NAME });
  }

  const inputList = await client.call("GetInputList", {
    inputKind: "browser_source"
  }) as InputListResponse;
  const inputExists = inputList.inputs?.some((input) => input.inputName === OBS_INPUT_NAME) ?? false;

  if (!inputExists) {
    await client.call("CreateInput", {
      sceneName: OBS_SCENE_NAME,
      inputName: OBS_INPUT_NAME,
      inputKind: "browser_source",
      inputSettings: browserSettings(stageUrl),
      sceneItemEnabled: true
    });
  } else {
    await client.call("SetInputSettings", {
      inputName: OBS_INPUT_NAME,
      inputSettings: browserSettings(stageUrl),
      overlay: true
    });
  }

  await client.call("SetInputAudioMonitorType", {
    inputName: OBS_INPUT_NAME,
    monitorType: "OBS_MONITORING_TYPE_MONITOR_ONLY"
  });

  const audioInputs = await client.call("GetInputList", {
    inputKind: "wasapi_input_capture"
  }) as InputListResponse;
  const humanMicExists = audioInputs.inputs?.some((input) => input.inputName === OBS_HUMAN_MIC_NAME) ?? false;
  if (!humanMicExists) {
    await client.call("CreateInput", {
      sceneName: OBS_SCENE_NAME,
      inputName: OBS_HUMAN_MIC_NAME,
      inputKind: "wasapi_input_capture",
      inputSettings: { device_id: "default" },
      sceneItemEnabled: true
    });
  }
  await client.call("SetInputAudioMonitorType", {
    inputName: OBS_HUMAN_MIC_NAME,
    monitorType: "OBS_MONITORING_TYPE_MONITOR_ONLY"
  });
  await client.call("SetInputMute", { inputName: OBS_HUMAN_MIC_NAME, inputMuted: true });

  const virtualCamera = await client.call("GetVirtualCamStatus") as VirtualCameraResponse;
  if (!virtualCamera.outputActive) {
    await client.call("SetVideoSettings", {
      fpsNumerator: 30,
      fpsDenominator: 1,
      baseWidth: OBS_WIDTH,
      baseHeight: OBS_HEIGHT,
      outputWidth: OBS_WIDTH,
      outputHeight: OBS_HEIGHT
    });
  }

  const sceneItemId = await getOrCreateSceneItem(client, !inputExists);
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
      boundsWidth: OBS_WIDTH,
      boundsHeight: OBS_HEIGHT,
      boundsAlignment: 0
    }
  });
  await client.call("SetCurrentProgramScene", {
    sceneName: OBS_SCENE_NAME
  });

  if (!virtualCamera.outputActive) {
    await client.call("StartVirtualCam");
  }

  return {
    sceneCreated: !sceneExists,
    inputCreated: !inputExists,
    audioMonitoringEnabled: true,
    virtualCameraStarted: !virtualCamera.outputActive,
    humanMicReady: true
  };
}

export async function getVirtualCameraStatus(client: ObsCallClient) {
  const response = await client.call("GetVirtualCamStatus") as VirtualCameraResponse;
  return response.outputActive;
}

export async function startVirtualCamera(client: ObsCallClient) {
  const active = await getVirtualCameraStatus(client);
  if (!active) await client.call("StartVirtualCam");
  return true;
}

export async function stopVirtualCamera(client: ObsCallClient) {
  const active = await getVirtualCameraStatus(client);
  if (active) await client.call("StopVirtualCam");
  return false;
}
