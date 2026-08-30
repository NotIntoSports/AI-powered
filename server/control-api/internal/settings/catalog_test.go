package settings

import "testing"

func TestClassifyModelID(t *testing.T) {
	cases := map[string]string{
		"qwen3.7-plus":          CapabilityLLM,
		"whisper-1":             CapabilityASR,
		"cosyvoice-v3-flash":    CapabilityTTS,
		"gpt-4o-realtime-preview": CapabilityE2E,
		"qwen3-omni-flash":      CapabilityE2E,
		"totally-random-xyz":    CapabilityUnknown,
	}
	for id, want := range cases {
		if got := ClassifyModelID(id); got != want {
			t.Fatalf("%s: got %s want %s", id, got, want)
		}
	}
}
