package settings

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func realtimeTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.CloseNow()
		if _, _, err = conn.Read(r.Context()); err != nil {
			t.Error(err)
			return
		}
		_ = conn.Write(r.Context(), websocket.MessageText, []byte(`{"type":"session.updated"}`))
	}))
}

func TestSetProviderModelRealtimePersistsVerificationAndReusesIt(t *testing.T) {
	pool := openSettingsTestPool(t)
	box := mustBox(t)
	svc := NewService(pool, box, nil)
	store := NewStore(pool, box)
	ctx := context.Background()
	actor := createSettingsUser(t, pool)
	server := realtimeTestServer(t)
	defer server.Close()
	enabled := true
	provider, err := svc.CreateAIProvider(ctx, actor, "req", AIProviderInput{Name: "Custom", BaseURL: server.URL + "/v1", APIKey: "secret", Enabled: &enabled, QuestionTimeoutMs: 60000, ReportTimeoutMs: 180000})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertDiscoveredModels(ctx, provider.BaseURL, []DiscoveredModel{{ProviderID: provider.ID, ModelID: "audio-model", BaseURL: provider.BaseURL, Enabled: true, Capability: CapabilityLLM}}); err != nil {
		t.Fatal(err)
	}

	model, err := svc.SetProviderModelRealtime(ctx, provider.ID, "audio-model", true, false)
	if err != nil {
		t.Fatal(err)
	}
	if !model.RealtimeSupported || !model.RealtimeEnabled || model.RealtimeVerificationStatus != RealtimeVerificationVerified || model.RealtimeVerifiedAt == nil || model.RealtimeVerifiedProviderVersion != provider.ConfigVersion {
		t.Fatalf("verified model=%+v", model)
	}
	catalog, err := store.ListCatalog(ctx, CapabilityE2E, "")
	if err != nil || len(catalog) != 1 || catalog[0].ModelID != "audio-model" {
		t.Fatalf("e2e catalog=%+v err=%v", catalog, err)
	}
	if err := svc.validateVoiceRouteModels(ctx, VoiceRouteInput{Name: "Realtime", Mode: PipelineModeE2E, E2EProviderID: provider.ID, E2EModelID: "audio-model"}); err != nil {
		t.Fatalf("validate realtime model with llm capability: %v", err)
	}
	endpoint, err := svc.resolvePipelineEndpoint(ctx, provider.ID, "audio-model")
	if err != nil || !endpoint.RealtimeEnabled {
		t.Fatalf("endpoint=%+v err=%v", endpoint, err)
	}
	server.Close()
	model, err = svc.SetProviderModelRealtime(ctx, provider.ID, "audio-model", false, false)
	if err != nil || model.RealtimeEnabled {
		t.Fatalf("disable model=%+v err=%v", model, err)
	}
	model, err = svc.SetProviderModelRealtime(ctx, provider.ID, "audio-model", true, false)
	if err != nil || !model.RealtimeEnabled {
		t.Fatalf("reuse model=%+v err=%v", model, err)
	}

	// A connection-setting change invalidates the previous proof immediately.
	server2 := realtimeTestServer(t)
	defer server2.Close()
	_, err = svc.UpdateAIProvider(ctx, actor, "req2", provider.ID, AIProviderInput{Name: provider.Name, BaseURL: server2.URL + "/v1", APIKey: "new-secret", Enabled: &enabled, QuestionTimeoutMs: 60000, ReportTimeoutMs: 180000})
	if err != nil {
		t.Fatal(err)
	}
	models, err := svc.ListProviderModels(ctx, provider.ID)
	if err != nil {
		t.Fatal(err)
	}
	model = modelsByID(models)["audio-model"]
	if model.RealtimeEnabled || model.RealtimeSupported || model.RealtimeVerificationStatus != RealtimeVerificationStale {
		t.Fatalf("stale model=%+v", model)
	}
	_ = time.Now() // keep timestamp assertions explicit without relying on wall-clock equality
}

func TestConcurrentRealtimeEnablePerformsOneProbe(t *testing.T) {
	pool := openSettingsTestPool(t)
	box := mustBox(t)
	svc := NewService(pool, box, nil)
	store := NewStore(pool, box)
	ctx := context.Background()
	actor := createSettingsUser(t, pool)
	var connections atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connections.Add(1)
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		_, _, _ = conn.Read(r.Context())
		time.Sleep(100 * time.Millisecond)
		_ = conn.Write(r.Context(), websocket.MessageText, []byte(`{"type":"session.updated"}`))
	}))
	defer server.Close()
	enabled := true
	provider, err := svc.CreateAIProvider(ctx, actor, "req", AIProviderInput{Name: "Concurrent", BaseURL: server.URL + "/v1", APIKey: "secret", Enabled: &enabled, QuestionTimeoutMs: 60000, ReportTimeoutMs: 180000})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertDiscoveredModels(ctx, provider.BaseURL, []DiscoveredModel{{ProviderID: provider.ID, ModelID: "audio", Enabled: true}}); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	errs := make(chan error, 4)
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := svc.SetProviderModelRealtime(ctx, provider.ID, "audio", true, false)
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if connections.Load() != 1 {
		t.Fatalf("probe connections=%d want 1", connections.Load())
	}
}

func TestRealtimeEndpointUsesBaseURLDialect(t *testing.T) {
	tests := map[string]string{
		"https://api.openai.com/v1":                          "wss://api.openai.com/v1/realtime?model=audio-model",
		"https://gateway.example/openai/v1":                  "wss://gateway.example/openai/v1/realtime?model=audio-model",
		"https://dashscope.aliyuncs.com/compatible-mode/v1":  "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=audio-model",
		"https://token-plan.cn-beijing.maas.aliyuncs.com/v1": "wss://token-plan.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=audio-model",
		"wss://gateway.example/api-ws/v1/realtime":           "wss://gateway.example/api-ws/v1/realtime?model=audio-model",
	}
	for baseURL, want := range tests {
		got, _, err := realtimeEndpoint(baseURL, "audio-model")
		if err != nil || got != want {
			t.Fatalf("realtimeEndpoint(%q)=%q,%v want %q", baseURL, got, err, want)
		}
	}
}

func TestProbeRealtimeWaitsForSessionUpdatedAndOmitsTranscription(t *testing.T) {
	received := make(chan map[string]any, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.CloseNow()
		_, body, err := conn.Read(r.Context())
		if err != nil {
			t.Error(err)
			return
		}
		var event map[string]any
		if err := json.Unmarshal(body, &event); err != nil {
			t.Error(err)
			return
		}
		received <- event
		_ = conn.Write(r.Context(), websocket.MessageText, []byte(`{"type":"session.created"}`))
		_ = conn.Write(r.Context(), websocket.MessageText, []byte(`{"type":"session.updated"}`))
	}))
	defer server.Close()

	result := probeRealtime(context.Background(), strings.Replace(server.URL, "http://", "ws://", 1)+"/v1", "model-without-name", "secret")
	if result.Status != RealtimeVerificationVerified || !result.Supported {
		t.Fatalf("probe result=%+v", result)
	}
	event := <-received
	session, _ := event["session"].(map[string]any)
	if _, exists := session["input_audio_transcription"]; exists {
		t.Fatalf("session.update contains transcription: %#v", session)
	}
}
