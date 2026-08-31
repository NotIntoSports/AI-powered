package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ai-interviewer/ai-powered/control-api/internal/sessions"
	"github.com/ai-interviewer/ai-powered/control-api/internal/settings"
	"github.com/ai-interviewer/ai-powered/control-api/internal/users"
)

func TestWriteSettingsErrorDistinguishesStoreFailure(t *testing.T) {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPut, "/api/v1/admin/settings/speech", nil)
	if writeSettingsError(recorder, request, settings.ErrStore) {
		t.Fatal("expected settings store error to be written")
	}
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusServiceUnavailable)
	}
	if body := recorder.Body.String(); !strings.Contains(body, `"code":"SETTINGS_STORE_UNAVAILABLE"`) || !strings.Contains(body, "settings database unavailable") {
		t.Fatalf("unexpected response body: %s", body)
	}
}

func TestWriteSettingsErrorAcceptsWrappedStoreFailure(t *testing.T) {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/v1/admin/settings/speech", nil)
	wrapped := fmt.Errorf("%w: %v", settings.ErrStore, errors.New("relation voice_routes does not exist"))
	if writeSettingsError(recorder, request, wrapped) {
		t.Fatal("expected wrapped store error to be written")
	}
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d", recorder.Code)
	}
}

type fakeSettingsAdmin struct {
	ai               settings.PublicAI
	clientAI         settings.ClientAI
	clientASR        settings.ClientASR
	clientSpeech     settings.ClientSpeech
	speech           settings.PublicSpeech
	rtc              settings.PublicRTC
	storage          settings.PublicStorage
	putAI            settings.AIInput
	putRTC           settings.RTCInput
	putSpeech        settings.SpeechInput
	speakerID        string
	allocationErr    error
	allocationAction string
	listVoices       func() (map[string]settings.UserSpeechVoice, error)
}

func (fake *fakeSettingsAdmin) GetRoles(context.Context) (settings.RoleProfiles, error) {
	return settings.RoleProfiles{}, nil
}

func (fake *fakeSettingsAdmin) PutRoles(_ context.Context, _ users.User, _ string, input []settings.RoleProfileInput) (settings.RoleProfiles, error) {
	profiles := make([]settings.RoleProfile, 0, len(input))
	for _, item := range input {
		profiles = append(profiles, settings.RoleProfile{Role: item.Role, OpeningTemplate: item.OpeningTemplate, ClosingTemplate: item.ClosingTemplate, Instructions: item.Instructions})
	}
	return settings.RoleProfiles{Roles: profiles}, nil
}

func (fake *fakeSettingsAdmin) GetAI(context.Context) (settings.PublicAI, error) {
	return fake.ai, nil
}

func (fake *fakeSettingsAdmin) GetClientAI(context.Context) (settings.ClientAI, error) {
	if fake.clientAI.APIKey != "" || fake.clientAI.Configured {
		return fake.clientAI, nil
	}
	return settings.ClientAI{PublicAI: fake.ai}, nil
}

func (fake *fakeSettingsAdmin) PutAI(_ context.Context, _ users.User, _ string, input settings.AIInput) (settings.PublicAI, error) {
	fake.putAI = input
	fake.ai = settings.PublicAI{
		Configured:       true,
		Available:        true,
		Provider:         "openai-compatible",
		BaseURL:          input.BaseURL,
		Model:            input.Model,
		APIKeyConfigured: input.APIKey != "",
		ConfigVersion:    1,
	}
	return fake.ai, nil
}

func (fake *fakeSettingsAdmin) TestAI(context.Context, users.User, string, *settings.AIInput) (settings.AITestResult, error) {
	return settings.AITestResult{Reachable: true, ModelFound: true, Message: "连接正常，已找到模型 gpt-4o-mini"}, nil
}

func (fake *fakeSettingsAdmin) GetClientASR(context.Context) (settings.ClientASR, error) {
	if fake.clientASR.APIKey != "" || fake.clientASR.Configured {
		return fake.clientASR, nil
	}
	return settings.ClientASR{}, nil
}

func (fake *fakeSettingsAdmin) GetRTC(context.Context) (settings.PublicRTC, error) {
	return fake.rtc, nil
}

func (fake *fakeSettingsAdmin) PutRTC(_ context.Context, _ users.User, _ string, input settings.RTCInput) (settings.PublicRTC, error) {
	fake.putRTC = input
	fake.rtc = settings.PublicRTC{
		Configured:              true,
		Available:               true,
		Provider:                settings.ProviderLiveKit,
		Language:                input.Language,
		LiveKitURL:              input.LiveKitURL,
		LiveKitAPIKey:           input.LiveKitAPIKey,
		LiveKitSecretConfigured: input.LiveKitAPISecret != "",
		LiveKitConfigured:       input.LiveKitURL != "" || input.LiveKitAPIKey != "" || input.LiveKitAPISecret != "",
		LiveKitAvailable:        input.LiveKitURL != "" && input.LiveKitAPIKey != "" && input.LiveKitAPISecret != "",
		ASRBaseURL:              input.ASRBaseURL,
		ASRModel:                input.ASRModel,
		ASRKeyConfigured:        input.ASRAPIKey != "",
	}
	return fake.rtc, nil
}

func (fake *fakeSettingsAdmin) TestRTC(context.Context, users.User, string, *settings.RTCInput) (settings.RTCTestResult, error) {
	return settings.RTCTestResult{Reachable: true, Message: "RTC 配置可用"}, nil
}

func (fake *fakeSettingsAdmin) IssueRTC(_ context.Context, roomID, userID string) (settings.RTCConnection, error) {
	return settings.RTCConnection{
		Provider:  settings.ProviderLiveKit,
		Token:     "issued-token",
		URL:       fake.rtc.LiveKitURL,
		RoomID:    roomID,
		UserID:    userID,
		Language:  "zh",
		ExpiresAt: "2026-08-16T08:00:00Z",
	}, nil
}

func (fake *fakeSettingsAdmin) GetStorage(context.Context) (settings.PublicStorage, error) {
	return fake.storage, nil
}

func (fake *fakeSettingsAdmin) PutStorage(_ context.Context, _ users.User, _ string, input settings.StorageInput) (settings.PublicStorage, error) {
	fake.storage = settings.PublicStorage{
		Configured:          true,
		Available:           true,
		Provider:            "tencent-cos",
		Region:              input.Region,
		Bucket:              input.Bucket,
		SecretID:            input.SecretID,
		SecretKeyConfigured: input.SecretKey != "",
	}
	return fake.storage, nil
}

func (fake *fakeSettingsAdmin) TestStorage(context.Context, users.User, string, *settings.StorageInput) (settings.StorageTestResult, error) {
	return settings.StorageTestResult{Reachable: true, Message: "Bucket 可访问"}, nil
}

func (fake *fakeSettingsAdmin) GetSpeech(context.Context) (settings.PublicSpeech, error) {
	return fake.speech, nil
}

func (fake *fakeSettingsAdmin) GetClientSpeech(_ context.Context, userID string) (settings.ClientSpeech, error) {
	_ = userID
	if fake.clientSpeech.APIKey != "" || fake.clientSpeech.AccessToken != "" || fake.clientSpeech.Configured {
		return fake.clientSpeech, nil
	}
	return settings.ClientSpeech{PublicSpeech: fake.speech}, nil
}

func (fake *fakeSettingsAdmin) PutSpeech(_ context.Context, _ users.User, _ string, input settings.SpeechInput) (settings.PublicSpeech, error) {
	fake.putSpeech = input
	fake.speech = settings.PublicSpeech{
		Configured:                      true,
		Available:                       true,
		AppID:                           input.AppID,
		SpeakerID:                       input.SpeakerID,
		TTSResourceID:                   input.TTSResourceID,
		ASRResourceID:                   input.ASRResourceID,
		APIKeyConfigured:                input.APIKey != "",
		AccessTokenConfigured:           input.AccessToken != "",
		SecretKeyConfigured:             input.SecretKey != "",
		Enabled:                         true,
		ActiveProvider:                  input.ActiveProvider,
		AliyunAppKey:                    input.AliyunAppKey,
		AliyunVoice:                     input.AliyunVoice,
		AliyunGateway:                   input.AliyunGateway,
		AliyunAccessKeyIDConfigured:     input.AliyunAccessKeyID != "",
		AliyunAccessKeySecretConfigured: input.AliyunAccessKeySecret != "",
		AliyunTokenConfigured:           input.AliyunToken != "",
		AliyunAvailable:                 input.AliyunAppKey != "" && (input.AliyunAccessKeyID != "" || input.AliyunToken != ""),
		ConfigVersion:                   1,
	}
	return fake.speech, nil
}

func (fake *fakeSettingsAdmin) PutClientSpeechSpeakerID(_ context.Context, userID, speakerID string) (settings.PublicSpeech, error) {
	fake.speakerID = speakerID
	fake.speech.SpeakerID = speakerID
	fake.speech.TTSAvailable = speakerID != ""
	if userID == "" {
		return settings.PublicSpeech{}, settings.ErrInvalidInput
	}
	return fake.speech, nil
}

func (fake *fakeSettingsAdmin) ReserveClientSpeechVoice(_ context.Context, userID string) (settings.VoiceAllocation, error) {
	fake.allocationAction = "reserve"
	if fake.allocationErr != nil {
		return settings.VoiceAllocation{}, fake.allocationErr
	}
	if userID == "" {
		return settings.VoiceAllocation{}, settings.ErrInvalidInput
	}
	return settings.VoiceAllocation{Status: settings.VoiceAllocationAllocating, Token: "allocation-token"}, nil
}

func (fake *fakeSettingsAdmin) CompleteClientSpeechVoice(_ context.Context, userID, token, speakerID string) (settings.PublicSpeech, error) {
	fake.allocationAction = "complete"
	if fake.allocationErr != nil {
		return settings.PublicSpeech{}, fake.allocationErr
	}
	fake.speakerID = speakerID
	return fake.speech, nil
}

func (fake *fakeSettingsAdmin) ReleaseClientSpeechVoice(_ context.Context, userID, token string) (settings.VoiceAllocation, error) {
	fake.allocationAction = "release"
	if fake.allocationErr != nil {
		return settings.VoiceAllocation{}, fake.allocationErr
	}
	return settings.VoiceAllocation{Status: settings.VoiceAllocationUnallocated}, nil
}

func (fake *fakeSettingsAdmin) ListUserSpeechVoices(context.Context) (map[string]settings.UserSpeechVoice, error) {
	if fake.listVoices != nil {
		return fake.listVoices()
	}
	return map[string]settings.UserSpeechVoice{}, nil
}

func (fake *fakeSettingsAdmin) TestSpeech(context.Context, users.User, string, *settings.SpeechInput) (settings.SpeechTestResult, error) {
	return settings.SpeechTestResult{Reachable: true, Message: "豆包语音鉴权可用"}, nil
}

func (fake *fakeSettingsAdmin) GetPipeline(context.Context) (settings.PublicPipeline, error) {
	return settings.EmptyPublicPipeline(), nil
}

func (fake *fakeSettingsAdmin) PutPipeline(_ context.Context, _ users.User, _ string, input settings.PipelineInput) (settings.PublicPipeline, error) {
	return settings.PublicPipelineFrom(settings.PipelineRecord{
		Mode: input.Mode, E2EProvider: input.E2EProvider, CascadedASR: settings.CascadedASRLiveKit, CascadedTTS: input.CascadedTTS,
	}), nil
}

func (fake *fakeSettingsAdmin) GetAgentSpeech(context.Context) (settings.AgentSpeechSettings, error) {
	return settings.AgentSpeechSettings{Language: "zh"}, nil
}

func (fake *fakeSettingsAdmin) GetAgentPipeline(context.Context) (settings.AgentPipeline, error) {
	return settings.AgentPipeline{Mode: settings.PipelineModeCascaded}, nil
}

func (fake *fakeSettingsAdmin) GetAgentAI(context.Context) (settings.AgentAISettings, error) {
	return settings.AgentAISettings{
		BaseURL:  "https://api.example.com/v1",
		Model:    "gpt-4o-audio-preview",
		APIKey:   "sk-test",
		Enabled:  true,
		Language: "zh",
	}, nil
}

func (fake *fakeSettingsAdmin) DeleteUserVoice(context.Context, string) error { return nil }

func (fake *fakeSettingsAdmin) PreviewSpeech(context.Context, *settings.SpeechInput) (settings.SpeechPreviewResult, error) {
	return settings.SpeechPreviewResult{Message: "preview"}, nil
}

func (fake *fakeSettingsAdmin) TestSpeechASR(context.Context, *settings.SpeechInput) (settings.SpeechASRTestResult, error) {
	return settings.SpeechASRTestResult{Message: "asr ok"}, nil
}

func (fake *fakeSettingsAdmin) ListSpeechVoices(context.Context) ([]settings.SpeechVoiceEntry, error) {
	return []settings.SpeechVoiceEntry{{ID: "xiaoyun", Name: "小云", Source: "catalog"}}, nil
}

func (fake *fakeSettingsAdmin) DiscoverModels(context.Context, string, string) ([]settings.DiscoveredModel, error) {
	return nil, nil
}

func (fake *fakeSettingsAdmin) ListDiscoveredModels(context.Context, string) ([]settings.DiscoveredModel, error) {
	return nil, nil
}

func (fake *fakeSettingsAdmin) SetModelEnabled(context.Context, string, string, bool) error {
	return nil
}

func (fake *fakeSettingsAdmin) GetEnabledModels(context.Context, string) ([]string, error) {
	return nil, nil
}

func (fake *fakeSettingsAdmin) ListAIProviders(context.Context) ([]settings.PublicAIProvider, error) {
	return []settings.PublicAIProvider{}, nil
}

func (fake *fakeSettingsAdmin) GetAIProvider(_ context.Context, id string) (settings.PublicAIProvider, error) {
	return settings.PublicAIProvider{ID: id, Configured: true}, nil
}

func (fake *fakeSettingsAdmin) CreateAIProvider(_ context.Context, _ users.User, _ string, input settings.AIProviderInput) (settings.PublicAIProvider, error) {
	return settings.PublicAIProvider{Name: input.Name, BaseURL: input.BaseURL, Model: input.Model, Configured: true, APIKeyConfigured: input.APIKey != ""}, nil
}

func (fake *fakeSettingsAdmin) UpdateAIProvider(_ context.Context, _ users.User, _ string, id string, input settings.AIProviderInput) (settings.PublicAIProvider, error) {
	return settings.PublicAIProvider{ID: id, Name: input.Name, BaseURL: input.BaseURL, Model: input.Model, Configured: true}, nil
}

func (fake *fakeSettingsAdmin) DeleteAIProvider(context.Context, users.User, string, string) error {
	return nil
}

func (fake *fakeSettingsAdmin) ActivateAIProvider(_ context.Context, _ users.User, _ string, id string) (settings.PublicAIProvider, error) {
	return settings.PublicAIProvider{ID: id, IsDefault: true, Configured: true}, nil
}

func (fake *fakeSettingsAdmin) TestAIProvider(context.Context, users.User, string, string, *settings.AIProviderInput) (settings.AITestResult, error) {
	return settings.AITestResult{Reachable: true, Message: "ok"}, nil
}

func (fake *fakeSettingsAdmin) DiscoverProviderModels(context.Context, string, *settings.AIProviderInput) ([]settings.DiscoveredModel, error) {
	return nil, nil
}

func (fake *fakeSettingsAdmin) ListProviderModels(context.Context, string) ([]settings.DiscoveredModel, error) {
	return nil, nil
}

func (fake *fakeSettingsAdmin) AddProviderModel(_ context.Context, _, modelID, ownedBy string) (settings.DiscoveredModel, error) {
	return settings.DiscoveredModel{ModelID: modelID, OwnedBy: ownedBy, Enabled: true}, nil
}

func (fake *fakeSettingsAdmin) DeleteProviderModel(context.Context, string, string) error {
	return nil
}

func (fake *fakeSettingsAdmin) SetProviderModelEnabled(context.Context, string, string, bool) error {
	return nil
}

func (fake *fakeSettingsAdmin) ActivateProviderModel(_ context.Context, _ users.User, _ string, providerID, modelID string) (settings.PublicAIProvider, error) {
	return settings.PublicAIProvider{ID: providerID, Model: modelID, IsDefault: true, Configured: true}, nil
}

func (fake *fakeSettingsAdmin) VerifyTokenPlanModel(_ context.Context, _, modelID string) (settings.ModelVerificationResult, error) {
	return settings.ModelVerificationResult{ModelID: modelID, Status: "success"}, nil
}

func (fake *fakeSettingsAdmin) SyncOfficialTokenPlanCatalog(context.Context) (settings.OfficialCatalogSyncResult, error) {
	return settings.OfficialCatalogSyncResult{}, nil
}

func (fake *fakeSettingsAdmin) ListCatalog(context.Context, string, string) ([]settings.CatalogEntry, error) {
	return []settings.CatalogEntry{}, nil
}

func (fake *fakeSettingsAdmin) SyncCatalog(context.Context) (settings.CatalogSyncResult, error) {
	return settings.CatalogSyncResult{}, nil
}

func (fake *fakeSettingsAdmin) ReclassifyCatalog(context.Context) (int, error) {
	return 0, nil
}

func (fake *fakeSettingsAdmin) PatchCatalogModel(_ context.Context, providerID, modelID string, _ settings.CatalogPatchInput) (settings.DiscoveredModel, error) {
	return settings.DiscoveredModel{ProviderID: providerID, ModelID: modelID, Capability: settings.CapabilityLLM}, nil
}

func (fake *fakeSettingsAdmin) GetClientPipeline(context.Context) (settings.ClientPipeline, error) {
	return settings.ClientPipeline{Mode: settings.PipelineModeCascaded}, nil
}

func TestAdminSettingsRequireAdministratorAndOmitSecrets(t *testing.T) {
	router := NewRouter(Dependencies{
		Authentication: adminBrowserAuth(),
		UserAdmin:      &fakeUserAdmin{list: func(users.User) ([]users.User, error) { return nil, nil }},
		SettingsAdmin:  &fakeSettingsAdmin{ai: settings.PublicAI{Configured: true, BaseURL: "https://api.openai.com/v1", APIKeyConfigured: true}},
	})
	response := performAdminCookieRequest(t, router, http.MethodGet, "/api/v1/admin/settings/ai", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	body := strings.ToLower(response.Body.String())
	if strings.Contains(body, "sk-") || strings.Contains(body, `"apikey":"`) {
		t.Fatalf("response leaked secret: %s", response.Body.String())
	}
	assertNoStore(t, response)
}

func TestAdminSettingsPutAIDoesNotEchoSubmittedKey(t *testing.T) {
	admin := &fakeSettingsAdmin{}
	router := NewRouter(Dependencies{
		Authentication: adminBrowserAuth(),
		UserAdmin:      &fakeUserAdmin{list: func(users.User) ([]users.User, error) { return nil, nil }},
		SettingsAdmin:  admin,
	})
	response := performAdminCookieRequest(t, router, http.MethodPut, "/api/v1/admin/settings/ai", `{"baseUrl":"https://api.openai.com/v1","model":"gpt-4o-mini","apiKey":"sk-secret-value"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "sk-secret-value") {
		t.Fatal("put response echoed api key")
	}
	if admin.putAI.APIKey != "sk-secret-value" || admin.putAI.BaseURL != "https://api.openai.com/v1" {
		t.Fatalf("stored input=%#v", admin.putAI)
	}
	var public settings.PublicAI
	decodeJSON(t, response, &public)
	if !public.APIKeyConfigured || public.Model != "gpt-4o-mini" {
		t.Fatalf("public=%#v", public)
	}
}

func TestAdminSettingsPutStorageDoesNotEchoSecretKey(t *testing.T) {
	admin := &fakeSettingsAdmin{}
	router := NewRouter(Dependencies{
		Authentication: adminBrowserAuth(),
		UserAdmin:      &fakeUserAdmin{list: func(users.User) ([]users.User, error) { return nil, nil }},
		SettingsAdmin:  admin,
	})
	response := performAdminCookieRequest(t, router, http.MethodPut, "/api/v1/admin/settings/storage", `{"region":"ap-guangzhou","bucket":"resume-1250000000","secretId":"AKIDexample","secretKey":"super-secret-key"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "super-secret-key") {
		t.Fatal("put response echoed secret key")
	}
	var public settings.PublicStorage
	decodeJSON(t, response, &public)
	if !public.SecretKeyConfigured || public.Bucket != "resume-1250000000" || public.SecretID != "AKIDexample" {
		t.Fatalf("public=%#v", public)
	}
}

func TestAdminSettingsOperatorForbidden(t *testing.T) {
	router := NewRouter(Dependencies{
		Authentication: &fakeAuthentication{
			authenticate: func(rawToken, purpose string) (AuthenticatedSession, error) {
				return AuthenticatedSession{
					User: users.User{ID: "op", Username: "op", Role: users.RoleOperator, Status: users.StatusActive},
					Session: sessions.Session{
						ID:      "session-operator",
						UserID:  "op",
						Purpose: sessions.PurposeBrowser,
					},
					RawToken: rawToken,
				}, nil
			},
		},
		UserAdmin:     &fakeUserAdmin{},
		SettingsAdmin: &fakeSettingsAdmin{},
	})
	response := performAdminCookieRequest(t, router, http.MethodGet, "/api/v1/admin/settings/ai", "")
	assertAPIError(t, response, http.StatusForbidden, "FORBIDDEN")
}

func TestClientRTCTokenIssuesLiveKitConnection(t *testing.T) {
	router := NewRouter(Dependencies{
		Authentication: adminBrowserAuth(),
		SettingsAdmin:  &fakeSettingsAdmin{rtc: settings.PublicRTC{LiveKitURL: "wss://livekit.example.com", Provider: settings.ProviderLiveKit}},
	})
	response := performAdminCookieRequest(t, router, http.MethodPost, "/api/v1/client/rtc/token", `{"roomId":"interview_1","userId":"bridge_1"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if strings.Contains(strings.ToLower(response.Body.String()), "secret") {
		t.Fatal("token response leaked secret field")
	}
	var connection settings.RTCConnection
	decodeJSON(t, response, &connection)
	if connection.Provider != settings.ProviderLiveKit || connection.RoomID != "interview_1" || connection.Token == "" {
		t.Fatalf("connection=%#v", connection)
	}
}

func TestAdminSettingsPutRTCAcceptsLiveKitFieldsAndOmitsSecret(t *testing.T) {
	admin := &fakeSettingsAdmin{}
	router := NewRouter(Dependencies{
		Authentication: adminBrowserAuth(),
		UserAdmin:      &fakeUserAdmin{list: func(users.User) ([]users.User, error) { return nil, nil }},
		SettingsAdmin:  admin,
	})
	response := performAdminCookieRequest(t, router, http.MethodPut, "/api/v1/admin/settings/rtc", `{"language":"zh","livekitUrl":"wss://livekit.example.com","livekitApiKey":"devkey","livekitApiSecret":"lk-secret-value"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "lk-secret-value") {
		t.Fatal("put response echoed livekit secret")
	}
	if admin.putRTC.LiveKitURL != "wss://livekit.example.com" || admin.putRTC.LiveKitAPISecret != "lk-secret-value" {
		t.Fatalf("stored input=%#v", admin.putRTC)
	}
	var public settings.PublicRTC
	decodeJSON(t, response, &public)
	if public.Provider != settings.ProviderLiveKit || !public.LiveKitSecretConfigured || public.LiveKitURL != "wss://livekit.example.com" {
		t.Fatalf("public=%#v", public)
	}
}

func TestClientRTCTokenIssuesLiveKitConnectionWithURL(t *testing.T) {
	router := NewRouter(Dependencies{
		Authentication: adminBrowserAuth(),
		SettingsAdmin: &fakeSettingsAdmin{rtc: settings.PublicRTC{
			Provider:   settings.ProviderLiveKit,
			LiveKitURL: "wss://livekit.example.com",
		}},
	})
	response := performAdminCookieRequest(t, router, http.MethodPost, "/api/v1/client/rtc/token", `{"roomId":"interview_2","userId":"bridge_2"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var connection settings.RTCConnection
	decodeJSON(t, response, &connection)
	if connection.Provider != settings.ProviderLiveKit || connection.URL != "wss://livekit.example.com" {
		t.Fatalf("connection=%#v", connection)
	}
}

func TestClientRuntimeModelSettingsAreNotExposed(t *testing.T) {
	router := NewRouter(Dependencies{
		Authentication: adminBrowserAuth(),
		SettingsAdmin: &fakeSettingsAdmin{
			clientAI:  settings.ClientAI{APIKey: "sk-ai-must-not-leak"},
			clientASR: settings.ClientASR{APIKey: "sk-asr-must-not-leak"},
		},
	})
	for _, path := range []string{"/api/v1/client/settings/ai", "/api/v1/client/settings/asr", "/api/v1/client/settings/pipeline"} {
		response := performAdminCookieRequest(t, router, http.MethodGet, path, "")
		if response.Code != http.StatusNotFound {
			t.Fatalf("path=%s status=%d body=%s", path, response.Code, response.Body.String())
		}
		if strings.Contains(response.Body.String(), "must-not-leak") {
			t.Fatalf("path=%s leaked runtime credentials", path)
		}
	}
}

func TestAdminSpeechSettingsOmitSecrets(t *testing.T) {
	router := NewRouter(Dependencies{
		Authentication: adminBrowserAuth(),
		UserAdmin:      &fakeUserAdmin{list: func(users.User) ([]users.User, error) { return nil, nil }},
		SettingsAdmin: &fakeSettingsAdmin{speech: settings.PublicSpeech{
			Configured:       true,
			Available:        true,
			AppID:            "8358554445",
			APIKeyConfigured: true,
		}},
	})
	response := performAdminCookieRequest(t, router, http.MethodGet, "/api/v1/admin/settings/speech", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	body := strings.ToLower(response.Body.String())
	if strings.Contains(body, `"apikey":"`) || strings.Contains(body, `"accesstoken":"`) || strings.Contains(body, `"secretkey":"`) {
		t.Fatalf("response leaked secret: %s", response.Body.String())
	}
	assertNoStore(t, response)
}

func TestAdminSettingsPutSpeechDoesNotEchoSubmittedKey(t *testing.T) {
	admin := &fakeSettingsAdmin{}
	router := NewRouter(Dependencies{
		Authentication: adminBrowserAuth(),
		UserAdmin:      &fakeUserAdmin{list: func(users.User) ([]users.User, error) { return nil, nil }},
		SettingsAdmin:  admin,
	})
	response := performAdminCookieRequest(t, router, http.MethodPut, "/api/v1/admin/settings/speech", `{"appId":"8358554445","apiKey":"volc-secret-key","accessToken":"volc-access-token"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "volc-secret-key") || strings.Contains(response.Body.String(), "volc-access-token") {
		t.Fatal("put response echoed speech secrets")
	}
	if admin.putSpeech.APIKey != "volc-secret-key" || admin.putSpeech.AccessToken != "volc-access-token" || admin.putSpeech.AppID != "8358554445" {
		t.Fatalf("stored input=%#v", admin.putSpeech)
	}
	var public settings.PublicSpeech
	decodeJSON(t, response, &public)
	if !public.APIKeyConfigured || !public.AccessTokenConfigured || public.AppID != "8358554445" {
		t.Fatalf("public=%#v", public)
	}
}

func TestClientSpeechSettingsReturnsRuntimeKeyForDesktop(t *testing.T) {
	router := NewRouter(Dependencies{
		Authentication: &fakeAuthentication{
			authenticate: func(rawToken, purpose string) (AuthenticatedSession, error) {
				if rawToken != "desktop-token" || purpose != sessions.PurposeDesktop {
					return AuthenticatedSession{}, ErrUnauthenticated
				}
				return AuthenticatedSession{
					User:     users.User{ID: "op", Username: "admin", Role: users.RoleOperator, Status: users.StatusActive},
					Session:  sessions.Session{ID: "session-desktop", UserID: "op", Purpose: sessions.PurposeDesktop},
					RawToken: rawToken,
				}, nil
			},
		},
		SettingsAdmin: &fakeSettingsAdmin{clientSpeech: settings.ClientSpeech{
			PublicSpeech: settings.PublicSpeech{
				Configured:   true,
				Available:    true,
				AppID:        "8358554445",
				SpeakerID:    "custom_zh_interviewer",
				TTSAvailable: true,
				ASRAvailable: true,
			},
			APIKey:      "volc-client-runtime",
			AccessToken: "volc-client-token",
		}},
	})
	response := performRequest(t, router, http.MethodGet, "/api/v1/client/settings/speech", "", map[string]string{
		"Authorization": "Bearer desktop-token",
	})
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var body settings.ClientSpeech
	decodeJSON(t, response, &body)
	if body.APIKey != "volc-client-runtime" || body.AccessToken != "volc-client-token" || body.SpeakerID != "custom_zh_interviewer" {
		t.Fatalf("client speech=%#v", body)
	}
}

func TestClientSpeechSettingsRejectsBrowserSession(t *testing.T) {
	router := NewRouter(Dependencies{
		Authentication: adminBrowserAuth(),
		SettingsAdmin: &fakeSettingsAdmin{clientSpeech: settings.ClientSpeech{
			APIKey:      "volc-should-not-leak",
			AccessToken: "token-should-not-leak",
		}},
	})
	response := performAdminCookieRequest(t, router, http.MethodGet, "/api/v1/client/settings/speech", "")
	assertAPIError(t, response, http.StatusForbidden, "FORBIDDEN")
	if strings.Contains(response.Body.String(), "volc-should-not-leak") || strings.Contains(response.Body.String(), "token-should-not-leak") {
		t.Fatal("browser session received client speech secrets")
	}
}

func TestClientSpeechPatchSpeakerIDRequiresDesktop(t *testing.T) {
	admin := &fakeSettingsAdmin{speech: settings.PublicSpeech{Configured: true, Available: true}}
	router := NewRouter(Dependencies{
		Authentication: &fakeAuthentication{
			authenticate: func(rawToken, purpose string) (AuthenticatedSession, error) {
				if rawToken != "desktop-token" || purpose != sessions.PurposeDesktop {
					return AuthenticatedSession{}, ErrUnauthenticated
				}
				return AuthenticatedSession{
					User:     users.User{ID: "op", Username: "admin", Role: users.RoleOperator, Status: users.StatusActive},
					Session:  sessions.Session{ID: "session-desktop", UserID: "op", Purpose: sessions.PurposeDesktop},
					RawToken: rawToken,
				}, nil
			},
		},
		SettingsAdmin: admin,
	})
	response := performRequest(t, router, http.MethodPatch, "/api/v1/client/settings/speech", `{"speakerId":"custom_zh_interviewer"}`, map[string]string{
		"Authorization": "Bearer desktop-token",
		"Content-Type":  "application/json",
	})
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if admin.speakerID != "custom_zh_interviewer" {
		t.Fatalf("speakerID=%q", admin.speakerID)
	}
}

func TestClientSpeechVoiceAllocationReturnsStableConflictCodes(t *testing.T) {
	admin := &fakeSettingsAdmin{allocationErr: settings.ErrVoiceAlreadyAllocated}
	authentication := &fakeAuthentication{authenticate: func(rawToken, purpose string) (AuthenticatedSession, error) {
		if rawToken != "desktop-token" || purpose != sessions.PurposeDesktop {
			return AuthenticatedSession{}, ErrUnauthenticated
		}
		return AuthenticatedSession{User: users.User{ID: "op", Role: users.RoleOperator, Status: users.StatusActive}, Session: sessions.Session{ID: "desktop", UserID: "op", Purpose: sessions.PurposeDesktop}, RawToken: rawToken}, nil
	}}
	router := NewRouter(Dependencies{Authentication: authentication, SettingsAdmin: admin})
	response := performRequest(t, router, http.MethodPatch, "/api/v1/client/settings/speech", `{"action":"reserve"}`, map[string]string{
		"Authorization": "Bearer desktop-token", "Content-Type": "application/json",
	})
	assertAPIError(t, response, http.StatusConflict, "VOICE_ALREADY_ALLOCATED")
	admin.allocationErr = settings.ErrVoiceAllocationInProgress
	response = performRequest(t, router, http.MethodPatch, "/api/v1/client/settings/speech", `{"action":"reserve"}`, map[string]string{
		"Authorization": "Bearer desktop-token", "Content-Type": "application/json",
	})
	assertAPIError(t, response, http.StatusConflict, "VOICE_ALLOCATION_IN_PROGRESS")
}
