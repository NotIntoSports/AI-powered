package settings

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestEnableOfficialRealtimeModelForVoiceRoute(t *testing.T) {
	pool := openSettingsTestPool(t)
	box := mustBox(t)
	svc := NewService(pool, box, nil)
	store := NewStore(pool, box)
	ctx := context.Background()
	actor := createSettingsUser(t, pool)
	enabled := true
	provider, err := svc.CreateAIProvider(ctx, actor, "req", AIProviderInput{
		Name:              "Token Plan",
		BaseURL:           TokenPlanPersonalBaseURL,
		Enabled:           &enabled,
		APIKey:            "sk-test",
		QuestionTimeoutMs: 60000,
		ReportTimeoutMs:   180000,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.ReplaceOfficialTokenPlanCatalog(ctx, []OfficialTokenPlanModel{
		{ModelID: "glm-5.2", Capability: CapabilityLLM, Protocol: "chat-completions"},
		{ModelID: "qwen-audio-3.0-realtime-plus", Capability: CapabilityE2E, Protocol: "realtime"},
		{ModelID: "qwen-audio-3.0-asr-flash", Capability: CapabilityASR, Protocol: "asr"},
	}, "2026-01-01", "hash", time.Now().UTC()); err != nil {
		t.Fatal(err)
	}

	listed, err := svc.ListProviderModels(ctx, provider.ID)
	if err != nil {
		t.Fatal(err)
	}
	byID := modelsByID(listed)
	if byID["qwen-audio-3.0-realtime-plus"].Enabled {
		t.Fatal("official-only realtime should start disabled")
	}

	if err := svc.SetProviderModelEnabled(ctx, provider.ID, "qwen-audio-3.0-realtime-plus", true); err != nil {
		t.Fatal(err)
	}
	listed, err = svc.ListProviderModels(ctx, provider.ID)
	if err != nil {
		t.Fatal(err)
	}
	byID = modelsByID(listed)
	if !byID["qwen-audio-3.0-realtime-plus"].Enabled {
		t.Fatal("enable should persist for official-only realtime model")
	}

	catalog, err := store.ListCatalog(ctx, CapabilityE2E, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog) != 1 || catalog[0].ModelID != "qwen-audio-3.0-realtime-plus" || !catalog[0].Enabled || !catalog[0].RuntimeVerified {
		t.Fatalf("e2e catalog = %#v", catalog)
	}

	if err := svc.validateVoiceRouteModels(ctx, VoiceRouteInput{
		Name: "端到端", Mode: PipelineModeE2E,
		E2EProviderID: provider.ID, E2EModelID: "qwen-audio-3.0-realtime-plus",
	}); err != nil {
		t.Fatalf("realtime voice route: %v", err)
	}

	if err := svc.SetProviderModelEnabled(ctx, provider.ID, "glm-5.2", true); err != nil {
		t.Fatal(err)
	}
	ok, err := store.TokenPlanModelVerified(ctx, provider.ID, "glm-5.2")
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("untested chat model must still require interactive verification")
	}
	ok, err = store.TokenPlanModelVerified(ctx, provider.ID, "qwen-audio-3.0-realtime-plus")
	if err != nil || !ok {
		t.Fatalf("realtime verified=%v err=%v", ok, err)
	}

	if err := svc.SetProviderModelEnabled(ctx, provider.ID, "qwen-audio-3.0-realtime-plus", false); err != nil {
		t.Fatal(err)
	}
	listed, err = svc.ListProviderModels(ctx, provider.ID)
	if err != nil {
		t.Fatal(err)
	}
	if modelsByID(listed)["qwen-audio-3.0-realtime-plus"].Enabled {
		t.Fatal("disable should persist")
	}
}

func modelsByID(models []DiscoveredModel) map[string]DiscoveredModel {
	out := make(map[string]DiscoveredModel, len(models))
	for _, model := range models {
		out[model.ModelID] = model
	}
	return out
}

func TestEnableUnknownModelStillInvalid(t *testing.T) {
	pool := openSettingsTestPool(t)
	box := mustBox(t)
	svc := NewService(pool, box, nil)
	ctx := context.Background()
	actor := createSettingsUser(t, pool)
	enabled := true
	provider, err := svc.CreateAIProvider(ctx, actor, "req", AIProviderInput{
		Name: "Token Plan", BaseURL: TokenPlanPersonalBaseURL, Enabled: &enabled, APIKey: "sk-test",
		QuestionTimeoutMs: 60000, ReportTimeoutMs: 180000,
	})
	if err != nil {
		t.Fatal(err)
	}
	err = svc.SetProviderModelEnabled(ctx, provider.ID, "not-a-real-model", true)
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("error = %v, want ErrInvalidInput", err)
	}
}
