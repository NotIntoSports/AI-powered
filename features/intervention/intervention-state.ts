export type InterventionState = {
  aiPaused: boolean;
  ttsActive: boolean;
  humanMicActive: boolean;
  muted: boolean;
};

export const initialInterventionState = (): InterventionState => ({
  aiPaused: false,
  ttsActive: false,
  humanMicActive: false,
  muted: false
});

export const beginIntervention = (state: InterventionState): InterventionState => ({
  ...state,
  aiPaused: true,
  ttsActive: false,
  humanMicActive: !state.muted
});

export const endIntervention = (state: InterventionState): InterventionState => ({
  ...state,
  humanMicActive: false,
  aiPaused: true
});

export const resumeAi = (state: InterventionState): InterventionState => ({
  ...state,
  aiPaused: false,
  muted: false
});

export const emergencyMute = (state: InterventionState): InterventionState => ({
  ...state,
  aiPaused: true,
  ttsActive: false,
  humanMicActive: false,
  muted: true
});
