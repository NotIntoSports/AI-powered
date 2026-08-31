package settings

import "testing"

func TestNormalizeVoiceRouteRequiresModelsForMode(t *testing.T) {
	_, err := normalizeVoiceRouteInput(VoiceRouteInput{Name: "级联线路", Mode: PipelineModeCascaded})
	if err != ErrInvalidInput {
		t.Fatalf("cascaded error = %v, want ErrInvalidInput", err)
	}

	_, err = normalizeVoiceRouteInput(VoiceRouteInput{Name: "端到端线路", Mode: PipelineModeE2E})
	if err != ErrInvalidInput {
		t.Fatalf("e2e error = %v, want ErrInvalidInput", err)
	}
}

func TestNormalizeVoiceRouteKeepsMatchingModelReferences(t *testing.T) {
	input := VoiceRouteInput{
		Name: "  主线路  ", Mode: PipelineModeCascaded,
		ASRProviderID: "asr-provider", ASRModelID: "asr-model",
		LLMProviderID: "llm-provider", LLMModelID: "llm-model",
		TTSProviderID: "tts-provider", TTSModelID: "tts-model", VoiceID: "voice-1",
	}
	got, err := normalizeVoiceRouteInput(input)
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "主线路" || got.E2EProviderID != "" || got.E2EModelID != "" {
		t.Fatalf("normalized = %#v", got)
	}
}
