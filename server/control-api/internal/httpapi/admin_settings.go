package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/ai-interviewer/ai-powered/control-api/internal/secretbox"
	"github.com/ai-interviewer/ai-powered/control-api/internal/sessions"
	"github.com/ai-interviewer/ai-powered/control-api/internal/settings"
	"github.com/ai-interviewer/ai-powered/control-api/internal/users"
	"github.com/go-chi/chi/v5/middleware"
)

type SettingsAdmin interface {
	GetAI(ctx context.Context) (settings.PublicAI, error)
	GetClientAI(ctx context.Context) (settings.ClientAI, error)
	GetClientASR(ctx context.Context) (settings.ClientASR, error)
	PutAI(ctx context.Context, actor users.User, requestID string, input settings.AIInput) (settings.PublicAI, error)
	TestAI(ctx context.Context, actor users.User, requestID string, input *settings.AIInput) (settings.AITestResult, error)
	GetRTC(ctx context.Context) (settings.PublicRTC, error)
	PutRTC(ctx context.Context, actor users.User, requestID string, input settings.RTCInput) (settings.PublicRTC, error)
	TestRTC(ctx context.Context, actor users.User, requestID string, input *settings.RTCInput) (settings.RTCTestResult, error)
	IssueRTC(ctx context.Context, roomID, userID string) (settings.RTCConnection, error)
	GetSpeech(ctx context.Context) (settings.PublicSpeech, error)
	GetClientSpeech(ctx context.Context, userID string) (settings.ClientSpeech, error)
	PutSpeech(ctx context.Context, actor users.User, requestID string, input settings.SpeechInput) (settings.PublicSpeech, error)
	PutClientSpeechSpeakerID(ctx context.Context, userID, speakerID string) (settings.PublicSpeech, error)
	ListUserSpeechVoices(ctx context.Context) (map[string]settings.UserSpeechVoice, error)
	TestSpeech(ctx context.Context, actor users.User, requestID string, input *settings.SpeechInput) (settings.SpeechTestResult, error)
	GetStorage(ctx context.Context) (settings.PublicStorage, error)
	PutStorage(ctx context.Context, actor users.User, requestID string, input settings.StorageInput) (settings.PublicStorage, error)
	TestStorage(ctx context.Context, actor users.User, requestID string, input *settings.StorageInput) (settings.StorageTestResult, error)
	GetRoles(ctx context.Context) (settings.RoleProfiles, error)
	PutRoles(ctx context.Context, actor users.User, requestID string, input []settings.RoleProfileInput) (settings.RoleProfiles, error)
}

type voiceAllocationAdmin interface {
	ReserveClientSpeechVoice(ctx context.Context, userID string) (settings.VoiceAllocation, error)
	CompleteClientSpeechVoice(ctx context.Context, userID, token, speakerID string) (settings.PublicSpeech, error)
	ReleaseClientSpeechVoice(ctx context.Context, userID, token string) (settings.VoiceAllocation, error)
}

type aiSettingsRequest struct {
	Provider          string `json:"provider"`
	BaseURL           string `json:"baseUrl"`
	Model             string `json:"model"`
	QuestionTimeoutMs int    `json:"questionTimeoutMs"`
	ReportTimeoutMs   int    `json:"reportTimeoutMs"`
	Enabled           *bool  `json:"enabled"`
	APIKey            string `json:"apiKey"`
	ClearAPIKey       bool   `json:"clearApiKey"`
}

type rtcSettingsRequest struct {
	AppID              string `json:"appId"`
	Language           string `json:"language"`
	Mode               string `json:"mode"`
	TokenServiceURL    string `json:"tokenServiceUrl"`
	Secret             string `json:"secret"`
	ClearSecret        bool   `json:"clearSecret"`
	TrialExpiresAt     string `json:"trialExpiresAt"`
	TrialRoomID        string `json:"trialRoomId"`
	TrialUserID        string `json:"trialUserId"`
	Enabled            *bool  `json:"enabled"`
	ActiveProvider     string `json:"activeProvider"`
	LiveKitURL         string `json:"livekitUrl"`
	LiveKitAPIKey      string `json:"livekitApiKey"`
	LiveKitAPISecret   string `json:"livekitApiSecret"`
	ClearLiveKitSecret bool   `json:"clearLivekitSecret"`
	ASRBaseURL         string `json:"asrBaseUrl"`
	ASRModel           string `json:"asrModel"`
	ASRAPIKey          string `json:"asrApiKey"`
	ClearASRAPIKey     bool   `json:"clearAsrApiKey"`
	TestProvider       string `json:"testProvider"`
}

type storageSettingsRequest struct {
	Provider       string `json:"provider"`
	Region         string `json:"region"`
	Bucket         string `json:"bucket"`
	SecretID       string `json:"secretId"`
	SecretKey      string `json:"secretKey"`
	ClearSecretKey bool   `json:"clearSecretKey"`
	Enabled        *bool  `json:"enabled"`
}

type speechSettingsRequest struct {
	AppID                      string `json:"appId"`
	SpeakerID                  string `json:"speakerId"`
	TTSResourceID              string `json:"ttsResourceId"`
	ASRResourceID              string `json:"asrResourceId"`
	APIKey                     string `json:"apiKey"`
	AccessToken                string `json:"accessToken"`
	SecretKey                  string `json:"secretKey"`
	ClearAPIKey                bool   `json:"clearApiKey"`
	ClearAccessToken           bool   `json:"clearAccessToken"`
	ClearSecretKey             bool   `json:"clearSecretKey"`
	Enabled                    *bool  `json:"enabled"`
	ActiveProvider             string `json:"activeProvider"`
	AliyunAppKey               string `json:"aliyunAppKey"`
	AliyunVoice                string `json:"aliyunVoice"`
	AliyunGateway              string `json:"aliyunGateway"`
	AliyunEnabled              *bool  `json:"aliyunEnabled"`
	AliyunAccessKeyID          string `json:"aliyunAccessKeyId"`
	AliyunAccessKeySecret      string `json:"aliyunAccessKeySecret"`
	AliyunToken                string `json:"aliyunToken"`
	ClearAliyunAccessKeyID     bool   `json:"clearAliyunAccessKeyId"`
	ClearAliyunAccessKeySecret bool   `json:"clearAliyunAccessKeySecret"`
	ClearAliyunToken           bool   `json:"clearAliyunToken"`
	TestProvider               string `json:"testProvider"`
}

type adminSettingsHandler struct {
	admin SettingsAdmin
}

func newAdminSettingsHandler(admin SettingsAdmin) *adminSettingsHandler {
	return &adminSettingsHandler{admin: admin}
}

func (handler *adminSettingsHandler) getAI(w http.ResponseWriter, request *http.Request) {
	if _, ok := requestActor(w, request); !ok {
		return
	}
	public, err := handler.admin.GetAI(request.Context())
	if !writeSettingsError(w, request, err) {
		return
	}
	writeJSON(w, http.StatusOK, public)
}

func (handler *adminSettingsHandler) getRoles(w http.ResponseWriter, request *http.Request) {
	if _, ok := requestActor(w, request); !ok {
		return
	}
	profiles, err := handler.admin.GetRoles(request.Context())
	if !writeSettingsError(w, request, err) {
		return
	}
	writeJSON(w, http.StatusOK, profiles)
}

func (handler *adminSettingsHandler) getClientRoles(w http.ResponseWriter, request *http.Request) {
	authenticated, ok := request.Context().Value(authenticatedSessionKey{}).(AuthenticatedSession)
	if !ok {
		writeSessionError(w, request)
		return
	}
	if authenticated.Session.Purpose != sessions.PurposeDesktop {
		writeAPIError(w, request, http.StatusForbidden, "FORBIDDEN", "desktop session is required")
		return
	}
	profiles, err := handler.admin.GetRoles(request.Context())
	if !writeSettingsError(w, request, err) {
		return
	}
	writeJSON(w, http.StatusOK, profiles)
}

func (handler *adminSettingsHandler) putRoles(w http.ResponseWriter, request *http.Request) {
	actor, ok := requestActor(w, request)
	if !ok {
		return
	}
	var input struct {
		Roles []settings.RoleProfileInput `json:"roles"`
	}
	if err := decodeBoundedJSON(w, request, &input); err != nil {
		writeJSONDecodeError(w, request, err)
		return
	}
	profiles, err := handler.admin.PutRoles(request.Context(), actor, middleware.GetReqID(request.Context()), input.Roles)
	if !writeSettingsError(w, request, err) {
		return
	}
	writeJSON(w, http.StatusOK, profiles)
}

func (handler *adminSettingsHandler) getClientAI(w http.ResponseWriter, request *http.Request) {
	authenticated, ok := request.Context().Value(authenticatedSessionKey{}).(AuthenticatedSession)
	if !ok {
		writeSessionError(w, request)
		return
	}
	if authenticated.Session.Purpose != sessions.PurposeDesktop {
		writeAPIError(w, request, http.StatusForbidden, "FORBIDDEN", "desktop session is required")
		return
	}
	clientAI, err := handler.admin.GetClientAI(request.Context())
	if !writeSettingsError(w, request, err) {
		return
	}
	writeJSON(w, http.StatusOK, clientAI)
}

func (handler *adminSettingsHandler) getClientASR(w http.ResponseWriter, request *http.Request) {
	authenticated, ok := request.Context().Value(authenticatedSessionKey{}).(AuthenticatedSession)
	if !ok {
		writeSessionError(w, request)
		return
	}
	if authenticated.Session.Purpose != sessions.PurposeDesktop {
		writeAPIError(w, request, http.StatusForbidden, "FORBIDDEN", "desktop session is required")
		return
	}
	clientASR, err := handler.admin.GetClientASR(request.Context())
	if !writeSettingsError(w, request, err) {
		return
	}
	writeJSON(w, http.StatusOK, clientASR)
}

func (handler *adminSettingsHandler) putAI(w http.ResponseWriter, request *http.Request) {
	actor, ok := requestActor(w, request)
	if !ok {
		return
	}
	input := aiSettingsRequest{}
	if err := decodeBoundedJSON(w, request, &input); err != nil {
		writeJSONDecodeError(w, request, err)
		return
	}
	public, err := handler.admin.PutAI(request.Context(), actor, middleware.GetReqID(request.Context()), settings.AIInput{
		Provider:          input.Provider,
		BaseURL:           input.BaseURL,
		Model:             input.Model,
		QuestionTimeoutMs: input.QuestionTimeoutMs,
		ReportTimeoutMs:   input.ReportTimeoutMs,
		Enabled:           input.Enabled,
		APIKey:            input.APIKey,
		ClearAPIKey:       input.ClearAPIKey,
	})
	if !writeSettingsError(w, request, err) {
		return
	}
	writeJSON(w, http.StatusOK, public)
}

func (handler *adminSettingsHandler) testAI(w http.ResponseWriter, request *http.Request) {
	actor, ok := requestActor(w, request)
	if !ok {
		return
	}
	var payload *settings.AIInput
	if request.Body != nil && request.ContentLength != 0 {
		input := aiSettingsRequest{}
		if err := decodeBoundedJSON(w, request, &input); err != nil {
			writeJSONDecodeError(w, request, err)
			return
		}
		converted := settings.AIInput{
			Provider:          input.Provider,
			BaseURL:           input.BaseURL,
			Model:             input.Model,
			QuestionTimeoutMs: input.QuestionTimeoutMs,
			ReportTimeoutMs:   input.ReportTimeoutMs,
			Enabled:           input.Enabled,
			APIKey:            input.APIKey,
			ClearAPIKey:       input.ClearAPIKey,
		}
		payload = &converted
	}
	result, err := handler.admin.TestAI(request.Context(), actor, middleware.GetReqID(request.Context()), payload)
	if !writeSettingsError(w, request, err) {
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (handler *adminSettingsHandler) getRTC(w http.ResponseWriter, request *http.Request) {
	if _, ok := requestActor(w, request); !ok {
		return
	}
	public, err := handler.admin.GetRTC(request.Context())
	if !writeSettingsError(w, request, err) {
		return
	}
	writeJSON(w, http.StatusOK, public)
}

func (handler *adminSettingsHandler) putRTC(w http.ResponseWriter, request *http.Request) {
	actor, ok := requestActor(w, request)
	if !ok {
		return
	}
	input := rtcSettingsRequest{}
	if err := decodeBoundedJSON(w, request, &input); err != nil {
		writeJSONDecodeError(w, request, err)
		return
	}
	public, err := handler.admin.PutRTC(request.Context(), actor, middleware.GetReqID(request.Context()), rtcInputFromRequest(input))
	if !writeSettingsError(w, request, err) {
		return
	}
	writeJSON(w, http.StatusOK, public)
}

func (handler *adminSettingsHandler) testRTC(w http.ResponseWriter, request *http.Request) {
	actor, ok := requestActor(w, request)
	if !ok {
		return
	}
	var payload *settings.RTCInput
	if request.Body != nil && request.ContentLength != 0 {
		input := rtcSettingsRequest{}
		if err := decodeBoundedJSON(w, request, &input); err != nil {
			writeJSONDecodeError(w, request, err)
			return
		}
		converted := rtcInputFromRequest(input)
		payload = &converted
	}
	result, err := handler.admin.TestRTC(request.Context(), actor, middleware.GetReqID(request.Context()), payload)
	if !writeSettingsError(w, request, err) {
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (handler *adminSettingsHandler) issueRTC(w http.ResponseWriter, request *http.Request) {
	if _, ok := requestActor(w, request); !ok {
		return
	}
	var input struct {
		RoomID string `json:"roomId"`
		UserID string `json:"userId"`
	}
	if err := decodeBoundedJSON(w, request, &input); err != nil {
		writeJSONDecodeError(w, request, err)
		return
	}
	connection, err := handler.admin.IssueRTC(request.Context(), strings.TrimSpace(input.RoomID), strings.TrimSpace(input.UserID))
	if !writeSettingsError(w, request, err) {
		return
	}
	writeJSON(w, http.StatusOK, connection)
}

func (handler *adminSettingsHandler) getSpeech(w http.ResponseWriter, request *http.Request) {
	if _, ok := requestActor(w, request); !ok {
		return
	}
	public, err := handler.admin.GetSpeech(request.Context())
	if !writeSettingsError(w, request, err) {
		return
	}
	writeJSON(w, http.StatusOK, public)
}

func (handler *adminSettingsHandler) getClientSpeech(w http.ResponseWriter, request *http.Request) {
	authenticated, ok := request.Context().Value(authenticatedSessionKey{}).(AuthenticatedSession)
	if !ok {
		writeSessionError(w, request)
		return
	}
	if authenticated.Session.Purpose != sessions.PurposeDesktop {
		writeAPIError(w, request, http.StatusForbidden, "FORBIDDEN", "desktop session is required")
		return
	}
	clientSpeech, err := handler.admin.GetClientSpeech(request.Context(), authenticated.User.ID)
	if !writeSettingsError(w, request, err) {
		return
	}
	writeJSON(w, http.StatusOK, clientSpeech)
}

func (handler *adminSettingsHandler) putSpeech(w http.ResponseWriter, request *http.Request) {
	actor, ok := requestActor(w, request)
	if !ok {
		return
	}
	input := speechSettingsRequest{}
	if err := decodeBoundedJSON(w, request, &input); err != nil {
		writeJSONDecodeError(w, request, err)
		return
	}
	public, err := handler.admin.PutSpeech(request.Context(), actor, middleware.GetReqID(request.Context()), speechInputFromRequest(input))
	if !writeSettingsError(w, request, err) {
		return
	}
	writeJSON(w, http.StatusOK, public)
}

func (handler *adminSettingsHandler) patchClientSpeech(w http.ResponseWriter, request *http.Request) {
	authenticated, ok := request.Context().Value(authenticatedSessionKey{}).(AuthenticatedSession)
	if !ok {
		writeSessionError(w, request)
		return
	}
	if authenticated.Session.Purpose != sessions.PurposeDesktop {
		writeAPIError(w, request, http.StatusForbidden, "FORBIDDEN", "desktop session is required")
		return
	}
	var input struct {
		SpeakerID       string `json:"speakerId"`
		Action          string `json:"action"`
		AllocationToken string `json:"allocationToken"`
	}
	if err := decodeBoundedJSON(w, request, &input); err != nil {
		writeJSONDecodeError(w, request, err)
		return
	}
	var result any
	var err error
	allocationAdmin, supportsAllocation := handler.admin.(voiceAllocationAdmin)
	switch strings.TrimSpace(input.Action) {
	case "reserve":
		if !supportsAllocation {
			err = settings.ErrStore
		} else {
			result, err = allocationAdmin.ReserveClientSpeechVoice(request.Context(), authenticated.User.ID)
		}
	case "complete":
		if !supportsAllocation {
			err = settings.ErrStore
		} else {
			result, err = allocationAdmin.CompleteClientSpeechVoice(request.Context(), authenticated.User.ID, strings.TrimSpace(input.AllocationToken), strings.TrimSpace(input.SpeakerID))
		}
	case "release":
		if !supportsAllocation {
			err = settings.ErrStore
		} else {
			result, err = allocationAdmin.ReleaseClientSpeechVoice(request.Context(), authenticated.User.ID, strings.TrimSpace(input.AllocationToken))
		}
	case "":
		result, err = handler.admin.PutClientSpeechSpeakerID(request.Context(), authenticated.User.ID, strings.TrimSpace(input.SpeakerID))
	default:
		err = settings.ErrInvalidInput
	}
	if errors.Is(err, settings.ErrNotConfigured) {
		writeAPIError(w, request, http.StatusServiceUnavailable, "SPEECH_UNAVAILABLE", "请先在管理后台配置豆包语音")
		return
	}
	if !writeSettingsError(w, request, err) {
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (handler *adminSettingsHandler) testSpeech(w http.ResponseWriter, request *http.Request) {
	actor, ok := requestActor(w, request)
	if !ok {
		return
	}
	var payload *settings.SpeechInput
	if request.Body != nil && request.ContentLength != 0 {
		input := speechSettingsRequest{}
		if err := decodeBoundedJSON(w, request, &input); err != nil {
			writeJSONDecodeError(w, request, err)
			return
		}
		converted := speechInputFromRequest(input)
		payload = &converted
	}
	result, err := handler.admin.TestSpeech(request.Context(), actor, middleware.GetReqID(request.Context()), payload)
	if !writeSettingsError(w, request, err) {
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (handler *adminSettingsHandler) getStorage(w http.ResponseWriter, request *http.Request) {
	if _, ok := requestActor(w, request); !ok {
		return
	}
	public, err := handler.admin.GetStorage(request.Context())
	if !writeSettingsError(w, request, err) {
		return
	}
	writeJSON(w, http.StatusOK, public)
}

func (handler *adminSettingsHandler) putStorage(w http.ResponseWriter, request *http.Request) {
	actor, ok := requestActor(w, request)
	if !ok {
		return
	}
	input := storageSettingsRequest{}
	if err := decodeBoundedJSON(w, request, &input); err != nil {
		writeJSONDecodeError(w, request, err)
		return
	}
	public, err := handler.admin.PutStorage(request.Context(), actor, middleware.GetReqID(request.Context()), settings.StorageInput{
		Provider:       input.Provider,
		Region:         input.Region,
		Bucket:         input.Bucket,
		SecretID:       input.SecretID,
		SecretKey:      input.SecretKey,
		ClearSecretKey: input.ClearSecretKey,
		Enabled:        input.Enabled,
	})
	if !writeSettingsError(w, request, err) {
		return
	}
	writeJSON(w, http.StatusOK, public)
}

func (handler *adminSettingsHandler) testStorage(w http.ResponseWriter, request *http.Request) {
	actor, ok := requestActor(w, request)
	if !ok {
		return
	}
	var payload *settings.StorageInput
	if request.Body != nil && request.ContentLength != 0 {
		input := storageSettingsRequest{}
		if err := decodeBoundedJSON(w, request, &input); err != nil {
			writeJSONDecodeError(w, request, err)
			return
		}
		converted := settings.StorageInput{
			Provider:       input.Provider,
			Region:         input.Region,
			Bucket:         input.Bucket,
			SecretID:       input.SecretID,
			SecretKey:      input.SecretKey,
			ClearSecretKey: input.ClearSecretKey,
			Enabled:        input.Enabled,
		}
		payload = &converted
	}
	result, err := handler.admin.TestStorage(request.Context(), actor, middleware.GetReqID(request.Context()), payload)
	if !writeSettingsError(w, request, err) {
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func writeSettingsError(w http.ResponseWriter, request *http.Request, err error) bool {
	if err == nil {
		return true
	}
	switch {
	case errors.Is(err, settings.ErrVoiceAlreadyAllocated):
		writeAPIError(w, request, http.StatusConflict, "VOICE_ALREADY_ALLOCATED", "voice has already been allocated")
	case errors.Is(err, settings.ErrVoiceAllocationInProgress):
		writeAPIError(w, request, http.StatusConflict, "VOICE_ALLOCATION_IN_PROGRESS", "voice allocation is already in progress")
	case errors.Is(err, settings.ErrVoiceAllocationToken):
		writeAPIError(w, request, http.StatusConflict, "VOICE_ALLOCATION_TOKEN_INVALID", "voice allocation token is invalid")
	case errors.Is(err, settings.ErrInvalidInput):
		writeAPIError(w, request, http.StatusUnprocessableEntity, "INVALID_INPUT", "settings input is invalid")
	case errors.Is(err, settings.ErrNotConfigured), errors.Is(err, settings.ErrRTCUnavailable):
		writeAPIError(w, request, http.StatusServiceUnavailable, "RTC_UNAVAILABLE", "rtc provider is not available")
	case errors.Is(err, secretbox.ErrUnavailable), errors.Is(err, settings.ErrMasterKeyMissing):
		writeAPIError(w, request, http.StatusServiceUnavailable, "SETTINGS_KEY_MISSING", "settings master key is not configured")
	case errors.Is(err, settings.ErrDecryptFailed):
		writeAPIError(w, request, http.StatusServiceUnavailable, "SETTINGS_UNAVAILABLE", "stored settings cannot be decrypted")
	default:
		writeAPIError(w, request, http.StatusInternalServerError, "INTERNAL_ERROR", "settings service unavailable")
	}
	return false
}

func speechInputFromRequest(input speechSettingsRequest) settings.SpeechInput {
	return settings.SpeechInput{
		AppID:                      input.AppID,
		SpeakerID:                  input.SpeakerID,
		TTSResourceID:              input.TTSResourceID,
		ASRResourceID:              input.ASRResourceID,
		APIKey:                     input.APIKey,
		AccessToken:                input.AccessToken,
		SecretKey:                  input.SecretKey,
		ClearAPIKey:                input.ClearAPIKey,
		ClearAccessToken:           input.ClearAccessToken,
		ClearSecretKey:             input.ClearSecretKey,
		Enabled:                    input.Enabled,
		ActiveProvider:             input.ActiveProvider,
		AliyunAppKey:               input.AliyunAppKey,
		AliyunVoice:                input.AliyunVoice,
		AliyunGateway:              input.AliyunGateway,
		AliyunEnabled:              input.AliyunEnabled,
		AliyunAccessKeyID:          input.AliyunAccessKeyID,
		AliyunAccessKeySecret:      input.AliyunAccessKeySecret,
		AliyunToken:                input.AliyunToken,
		ClearAliyunAccessKeyID:     input.ClearAliyunAccessKeyID,
		ClearAliyunAccessKeySecret: input.ClearAliyunAccessKeySecret,
		ClearAliyunToken:           input.ClearAliyunToken,
		TestProvider:               input.TestProvider,
	}
}

func rtcInputFromRequest(input rtcSettingsRequest) settings.RTCInput {
	return settings.RTCInput{
		AppID:              input.AppID,
		Language:           input.Language,
		Mode:               input.Mode,
		TokenServiceURL:    input.TokenServiceURL,
		Secret:             input.Secret,
		ClearSecret:        input.ClearSecret,
		TrialExpiresAt:     input.TrialExpiresAt,
		TrialRoomID:        input.TrialRoomID,
		TrialUserID:        input.TrialUserID,
		Enabled:            input.Enabled,
		ActiveProvider:     input.ActiveProvider,
		LiveKitURL:         input.LiveKitURL,
		LiveKitAPIKey:      input.LiveKitAPIKey,
		LiveKitAPISecret:   input.LiveKitAPISecret,
		ClearLiveKitSecret: input.ClearLiveKitSecret,
		ASRBaseURL:         input.ASRBaseURL,
		ASRModel:           input.ASRModel,
		ASRAPIKey:          input.ASRAPIKey,
		ClearASRAPIKey:     input.ClearASRAPIKey,
		TestProvider:       input.TestProvider,
	}
}
