package httpapi

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/ai-interviewer/ai-powered/control-api/internal/sessions"
	"github.com/ai-interviewer/ai-powered/control-api/internal/settings"
	"github.com/ai-interviewer/ai-powered/control-api/internal/users"
)

type fakeSettingsAdmin struct {
	ai          settings.PublicAI
	clientAI    settings.ClientAI
	clientASR   settings.ClientASR
	clientSpeech settings.ClientSpeech
	speech      settings.PublicSpeech
	rtc         settings.PublicRTC
	storage     settings.PublicStorage
	putAI       settings.AIInput
	putRTC      settings.RTCInput
	putSpeech   settings.SpeechInput
	speakerID   string
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
	provider := input.ActiveProvider
	if provider == "" {
		provider = "volcengine"
	}
	fake.rtc = settings.PublicRTC{
		Configured:              true,
		Available:               true,
		ActiveProvider:          provider,
		AppID:                   input.AppID,
		Language:                input.Language,
		Mode:                    input.Mode,
		TokenServiceURL:         input.TokenServiceURL,
		SecretConfigured:        input.Secret != "",
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
	provider := fake.rtc.ActiveProvider
	if provider == "" {
		provider = "volcengine"
	}
	connection := settings.RTCConnection{
		Provider:  provider,
		Token:     "issued-token",
		RoomID:    roomID,
		UserID:    userID,
		Language:  "zh",
		ExpiresAt: "2026-08-16T08:00:00Z",
	}
	if provider == "livekit" {
		connection.URL = fake.rtc.LiveKitURL
		return connection, nil
	}
	connection.AppID = fake.rtc.AppID
	return connection, nil
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

func (fake *fakeSettingsAdmin) GetClientSpeech(context.Context) (settings.ClientSpeech, error) {
	if fake.clientSpeech.APIKey != "" || fake.clientSpeech.AccessToken != "" || fake.clientSpeech.Configured {
		return fake.clientSpeech, nil
	}
	return settings.ClientSpeech{PublicSpeech: fake.speech}, nil
}

func (fake *fakeSettingsAdmin) PutSpeech(_ context.Context, _ users.User, _ string, input settings.SpeechInput) (settings.PublicSpeech, error) {
	fake.putSpeech = input
	fake.speech = settings.PublicSpeech{
		Configured:            true,
		Available:             true,
		AppID:                 input.AppID,
		SpeakerID:             input.SpeakerID,
		TTSResourceID:         input.TTSResourceID,
		ASRResourceID:         input.ASRResourceID,
		APIKeyConfigured:      input.APIKey != "",
		AccessTokenConfigured: input.AccessToken != "",
		SecretKeyConfigured:   input.SecretKey != "",
		Enabled:               true,
		ConfigVersion:         1,
	}
	return fake.speech, nil
}

func (fake *fakeSettingsAdmin) PutClientSpeechSpeakerID(_ context.Context, speakerID string) (settings.PublicSpeech, error) {
	fake.speakerID = speakerID
	fake.speech.SpeakerID = speakerID
	fake.speech.TTSAvailable = speakerID != ""
	return fake.speech, nil
}

func (fake *fakeSettingsAdmin) TestSpeech(context.Context, users.User, string, *settings.SpeechInput) (settings.SpeechTestResult, error) {
	return settings.SpeechTestResult{Reachable: true, Message: "豆包语音鉴权可用"}, nil
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

func TestClientRTCTokenIssuesForActiveProvider(t *testing.T) {
	router := NewRouter(Dependencies{
		Authentication: adminBrowserAuth(),
		SettingsAdmin:  &fakeSettingsAdmin{rtc: settings.PublicRTC{AppID: "volc-app"}},
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
	if connection.Provider != "volcengine" || connection.RoomID != "interview_1" || connection.Token == "" {
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
	response := performAdminCookieRequest(t, router, http.MethodPut, "/api/v1/admin/settings/rtc", `{"activeProvider":"livekit","language":"zh","mode":"production","livekitUrl":"wss://livekit.example.com","livekitApiKey":"devkey","livekitApiSecret":"lk-secret-value"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "lk-secret-value") {
		t.Fatal("put response echoed livekit secret")
	}
	if admin.putRTC.ActiveProvider != "livekit" || admin.putRTC.LiveKitURL != "wss://livekit.example.com" || admin.putRTC.LiveKitAPISecret != "lk-secret-value" {
		t.Fatalf("stored input=%#v", admin.putRTC)
	}
	var public settings.PublicRTC
	decodeJSON(t, response, &public)
	if public.ActiveProvider != "livekit" || !public.LiveKitSecretConfigured || public.LiveKitURL != "wss://livekit.example.com" {
		t.Fatalf("public=%#v", public)
	}
}

func TestClientRTCTokenIssuesLiveKitConnection(t *testing.T) {
	router := NewRouter(Dependencies{
		Authentication: adminBrowserAuth(),
		SettingsAdmin: &fakeSettingsAdmin{rtc: settings.PublicRTC{
			ActiveProvider: "livekit",
			LiveKitURL:     "wss://livekit.example.com",
		}},
	})
	response := performAdminCookieRequest(t, router, http.MethodPost, "/api/v1/client/rtc/token", `{"roomId":"interview_2","userId":"bridge_2"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var connection settings.RTCConnection
	decodeJSON(t, response, &connection)
	if connection.Provider != "livekit" || connection.URL != "wss://livekit.example.com" || connection.AppID != "" {
		t.Fatalf("connection=%#v", connection)
	}
}

func TestClientAISettingsReturnsRuntimeKeyForDesktop(t *testing.T) {
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
		SettingsAdmin: &fakeSettingsAdmin{clientAI: settings.ClientAI{
			PublicAI: settings.PublicAI{
				Configured: true,
				Available:  true,
				BaseURL:    "https://api.openai.com/v1",
				Model:      "gpt-4o-mini",
			},
			APIKey: "sk-client-runtime",
		}},
	})
	response := performRequest(t, router, http.MethodGet, "/api/v1/client/settings/ai", "", map[string]string{
		"Authorization": "Bearer desktop-token",
	})
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var body settings.ClientAI
	decodeJSON(t, response, &body)
	if body.APIKey != "sk-client-runtime" || body.Model != "gpt-4o-mini" || !body.Available {
		t.Fatalf("client AI=%#v", body)
	}
}

func TestClientAISettingsRejectsBrowserSession(t *testing.T) {
	router := NewRouter(Dependencies{
		Authentication: adminBrowserAuth(),
		SettingsAdmin: &fakeSettingsAdmin{clientAI: settings.ClientAI{
			APIKey: "sk-should-not-leak",
		}},
	})
	response := performAdminCookieRequest(t, router, http.MethodGet, "/api/v1/client/settings/ai", "")
	assertAPIError(t, response, http.StatusForbidden, "FORBIDDEN")
	if strings.Contains(response.Body.String(), "sk-should-not-leak") {
		t.Fatal("browser session received client AI key")
	}
}

func TestClientASRSettingsReturnsRuntimeKeyForDesktop(t *testing.T) {
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
		SettingsAdmin: &fakeSettingsAdmin{clientASR: settings.ClientASR{
			Configured: true,
			Available:  true,
			BaseURL:    "https://speech.example.com/v1",
			Model:      "whisper-1",
			Language:   "zh",
			APIKey:     "sk-asr-runtime",
			Source:     "asr",
		}},
	})
	response := performRequest(t, router, http.MethodGet, "/api/v1/client/settings/asr", "", map[string]string{
		"Authorization": "Bearer desktop-token",
	})
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var body settings.ClientASR
	decodeJSON(t, response, &body)
	if body.APIKey != "sk-asr-runtime" || body.BaseURL != "https://speech.example.com/v1" || !body.Available {
		t.Fatalf("client ASR=%#v", body)
	}
}

func TestClientASRSettingsRejectsBrowserSession(t *testing.T) {
	router := NewRouter(Dependencies{
		Authentication: adminBrowserAuth(),
		SettingsAdmin: &fakeSettingsAdmin{clientASR: settings.ClientASR{
			APIKey: "sk-asr-should-not-leak",
		}},
	})
	response := performAdminCookieRequest(t, router, http.MethodGet, "/api/v1/client/settings/asr", "")
	assertAPIError(t, response, http.StatusForbidden, "FORBIDDEN")
	if strings.Contains(response.Body.String(), "sk-asr-should-not-leak") {
		t.Fatal("browser session received client ASR key")
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
