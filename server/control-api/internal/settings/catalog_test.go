package settings

import (
	"errors"
	"strings"
	"testing"
)

func TestCatalogRuntimeVerifiedRequiresSuccessfulTokenPlanVerification(t *testing.T) {
	if catalogRuntimeVerified(TokenPlanPersonalBaseURL, true, "untested", "chat-completions") {
		t.Fatal("untested Token Plan chat model must not be selectable")
	}
	if catalogRuntimeVerified(TokenPlanPersonalBaseURL, false, "success", "chat-completions") {
		t.Fatal("non-official Token Plan model must not be selectable")
	}
	if !catalogRuntimeVerified(TokenPlanPersonalBaseURL, true, "success", "chat-completions") {
		t.Fatal("official verified Token Plan chat model must be selectable")
	}
	if !catalogRuntimeVerified("https://example.com/v1", false, "untested", "") {
		t.Fatal("non-Token Plan providers keep their existing enabled readiness rule")
	}
}

func TestCatalogRuntimeVerifiedAllowsDedicatedProtocolsWithoutChatProbe(t *testing.T) {
	if !catalogRuntimeVerified(TokenPlanPersonalBaseURL, true, "untested", "realtime") {
		t.Fatal("official realtime model must be selectable without chat verification")
	}
	if !catalogRuntimeVerified(TokenPlanPersonalBaseURL, true, "unsupported", "asr") {
		t.Fatal("official asr model must be selectable without chat verification")
	}
	if !catalogRuntimeVerified(TokenPlanPersonalBaseURL, true, "unsupported", "tts") {
		t.Fatal("official tts model must be selectable without chat verification")
	}
	if catalogRuntimeVerified(TokenPlanPersonalBaseURL, true, "unsupported", "chat-completions") {
		t.Fatal("chat-completions still requires success")
	}
}

func TestCatalogCapabilityForStoreMapsMediaToUnknown(t *testing.T) {
	if catalogCapabilityForStore("video") != CapabilityUnknown {
		t.Fatal("video must map to unknown")
	}
	if catalogCapabilityForStore("image") != CapabilityUnknown {
		t.Fatal("image must map to unknown")
	}
	if catalogCapabilityForStore(CapabilityE2E) != CapabilityE2E {
		t.Fatal("e2e must be kept")
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

func TestWrapStoreKeepsErrStore(t *testing.T) {
	err := wrapStore(errors.New("relation discovered_models does not exist"))
	if !errors.Is(err, ErrStore) {
		t.Fatalf("wrapped = %v", err)
	}
	if !strings.Contains(err.Error(), "relation discovered_models does not exist") {
		t.Fatalf("wrapped message = %v", err)
	}
}
