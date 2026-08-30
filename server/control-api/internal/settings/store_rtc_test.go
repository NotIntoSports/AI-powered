package settings

import (
	"testing"
)

func TestPublicRTCLiveKitOnly(t *testing.T) {
	record := RTCRecord{
		Enabled:                   true,
		Language:                  "zh",
		LiveKitURL:                "ws://127.0.0.1:7880",
		LiveKitAPIKey:             "devkey",
		EncryptedLiveKitAPISecret: []byte("cipher"),
	}
	public := PublicRTCFrom(record, nil)
	if !public.Available || !public.LiveKitAvailable || public.Provider != ProviderLiveKit {
		t.Fatalf("public=%#v", public)
	}
}

func TestPublicRTCDecryptErrorDisablesLiveKit(t *testing.T) {
	record := RTCRecord{
		Enabled:                   true,
		Language:                  "zh",
		LiveKitURL:                "ws://127.0.0.1:7880",
		LiveKitAPIKey:             "devkey",
		EncryptedLiveKitAPISecret: []byte("cipher"),
	}
	public := PublicRTCFrom(record, ErrDecryptFailed)
	if public.Available || public.LiveKitAvailable {
		t.Fatalf("public=%#v", public)
	}
}

func TestNormalizeRTCLiveKitRequiresURLAndKey(t *testing.T) {
	input, err := normalizeRTCInput(RTCInput{
		Language: "zh", LiveKitURL: "wss://livekit.example.com", LiveKitAPIKey: "devkey",
	})
	if err != nil || input.LiveKitURL != "wss://livekit.example.com" {
		t.Fatalf("input=%#v err=%v", input, err)
	}
	_, err = normalizeRTCInput(RTCInput{Language: "zh", LiveKitAPIKey: "devkey"})
	if err != ErrInvalidInput {
		t.Fatalf("err=%v", err)
	}
}
