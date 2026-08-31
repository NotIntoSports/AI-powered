package settings

import "testing"

func TestCatalogRuntimeVerifiedRequiresSuccessfulTokenPlanVerification(t *testing.T) {
	if catalogRuntimeVerified(TokenPlanPersonalBaseURL, true, "untested") {
		t.Fatal("untested Token Plan model must not be selectable")
	}
	if catalogRuntimeVerified(TokenPlanPersonalBaseURL, false, "success") {
		t.Fatal("non-official Token Plan model must not be selectable")
	}
	if !catalogRuntimeVerified(TokenPlanPersonalBaseURL, true, "success") {
		t.Fatal("official verified Token Plan model must be selectable")
	}
	if !catalogRuntimeVerified("https://example.com/v1", false, "untested") {
		t.Fatal("non-Token Plan providers keep their existing enabled readiness rule")
	}
}

func TestClassifyModelID(t *testing.T) {
	cases := map[string]string{
		"qwen3.7-plus":            CapabilityLLM,
		"whisper-1":               CapabilityASR,
		"cosyvoice-v3-flash":      CapabilityTTS,
		"gpt-4o-realtime-preview": CapabilityE2E,
		"qwen3-omni-flash":        CapabilityE2E,
		"totally-random-xyz":      CapabilityUnknown,
	}
	for id, want := range cases {
		if got := ClassifyModelID(id); got != want {
			t.Fatalf("%s: got %s want %s", id, got, want)
		}
	}
}
