// Package settings stores encrypted AI and RTC configuration for the control API.
package settings

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/ai-interviewer/ai-powered/control-api/internal/database"
	"github.com/ai-interviewer/ai-powered/control-api/internal/secretbox"
	"github.com/ai-interviewer/ai-powered/control-api/internal/users"
	"github.com/jackc/pgx/v5"
)

var (
	ErrInvalidInput               = errors.New("invalid settings input")
	ErrMasterKeyMissing           = secretbox.ErrUnavailable
	ErrDecryptFailed              = secretbox.ErrCiphertext
	ErrNotConfigured              = errors.New("settings are not configured")
	ErrStore                      = errors.New("settings store unavailable")
	ErrRTCUnavailable             = errors.New("rtc provider is not available")
	ErrVoiceAlreadyAllocated      = errors.New("voice already allocated")
	ErrVoiceAllocationInProgress  = errors.New("voice allocation in progress")
	ErrVoiceAllocationToken       = errors.New("voice allocation token is invalid")
	ErrModelNotVerified           = errors.New("model has not passed interactive verification")
	ErrOfficialCatalogUnavailable = errors.New("official model catalog unavailable")
)

const (
	singletonID            = "default"
	defaultProvider        = "openai-compatible"
	defaultQuestionTimeout = 60_000
	defaultReportTimeout   = 180_000
	minTimeoutMs           = 1_000
	maxTimeoutMs           = 600_000
	ProviderLiveKit        = "livekit"
	livekitTokenTTL        = time.Hour
)

type AIRecord struct {
	ID                string
	Name              string
	IsDefault         bool
	Provider          string
	BaseURL           string
	Model             string
	QuestionTimeoutMs int
	ReportTimeoutMs   int
	Enabled           bool
	EncryptedAPIKey   []byte
	KeyVersion        int
	ConfigVersion     int
	UpdatedByUserID   string
	UpdatedByUsername string
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

type RTCRecord struct {
	Language                  string
	Enabled                   bool
	LiveKitURL                string
	LiveKitAPIKey             string
	EncryptedLiveKitAPISecret []byte
	LiveKitASRBaseURL         string
	LiveKitASRModel           string
	EncryptedASRAPIKey        []byte
	LiveKitKeyVersion         int
	PipelineMode              string
	ASRProviderID             string
	ASRModelID                string
	LLMProviderID             string
	LLMModelID                string
	TTSProviderID             string
	TTSModelID                string
	TTSVoiceID                string
	E2EProviderID             string
	E2EModelID                string
	ConfigVersion             int
	UpdatedByUserID           string
	UpdatedByUsername         string
	CreatedAt                 time.Time
	UpdatedAt                 time.Time
}

type AIInput struct {
	Provider          string
	BaseURL           string
	Model             string
	QuestionTimeoutMs int
	ReportTimeoutMs   int
	Enabled           *bool
	APIKey            string
	ClearAPIKey       bool
}

type RTCInput struct {
	Language           string
	Enabled            *bool
	LiveKitURL         string
	LiveKitAPIKey      string
	LiveKitAPISecret   string
	ClearLiveKitSecret bool
	ASRBaseURL         string
	ASRModel           string
	ASRAPIKey          string
	ClearASRAPIKey     bool
	PipelineMode       string
	ASRProviderID      string
	ASRModelID         string
	LLMProviderID      string
	LLMModelID         string
	TTSProviderID      string
	TTSModelID         string
	TTSVoiceID         string
	E2EProviderID      string
	E2EModelID         string
}

type PublicAI struct {
	Configured        bool       `json:"configured"`
	Available         bool       `json:"available"`
	Provider          string     `json:"provider"`
	BaseURL           string     `json:"baseUrl"`
	Model             string     `json:"model"`
	QuestionTimeoutMs int        `json:"questionTimeoutMs"`
	ReportTimeoutMs   int        `json:"reportTimeoutMs"`
	Enabled           bool       `json:"enabled"`
	APIKeyConfigured  bool       `json:"apiKeyConfigured"`
	LocalEndpoint     bool       `json:"localEndpoint"`
	ConfigVersion     int        `json:"configVersion"`
	UpdatedAt         *time.Time `json:"updatedAt,omitempty"`
	UpdatedByUsername string     `json:"updatedByUsername,omitempty"`
}

type ClientAI struct {
	PublicAI
	APIKey string `json:"apiKey,omitempty"`
}

type ClientASR struct {
	Configured bool   `json:"configured"`
	Available  bool   `json:"available"`
	BaseURL    string `json:"baseUrl"`
	Model      string `json:"model"`
	Language   string `json:"language"`
	APIKey     string `json:"apiKey,omitempty"`
	Source     string `json:"source,omitempty"`
}

type PublicRTC struct {
	Configured              bool       `json:"configured"`
	Available               bool       `json:"available"`
	Provider                string     `json:"provider"`
	Language                string     `json:"language"`
	LiveKitURL              string     `json:"livekitUrl"`
	LiveKitAPIKey           string     `json:"livekitApiKey"`
	LiveKitSecretConfigured bool       `json:"livekitSecretConfigured"`
	LiveKitConfigured       bool       `json:"livekitConfigured"`
	LiveKitAvailable        bool       `json:"livekitAvailable"`
	ASRBaseURL              string     `json:"asrBaseUrl"`
	ASRModel                string     `json:"asrModel"`
	ASRKeyConfigured        bool       `json:"asrKeyConfigured"`
	PipelineMode            string     `json:"pipelineMode"`
	ASRProviderID           string     `json:"asrProviderId"`
	ASRModelID              string     `json:"asrModelId"`
	LLMProviderID           string     `json:"llmProviderId"`
	LLMModelID              string     `json:"llmModelId"`
	TTSProviderID           string     `json:"ttsProviderId"`
	TTSModelID              string     `json:"ttsModelId"`
	TTSVoiceID              string     `json:"ttsVoiceId"`
	E2EProviderID           string     `json:"e2eProviderId"`
	E2EModelID              string     `json:"e2eModelId"`
	Enabled                 bool       `json:"enabled"`
	ConfigVersion           int        `json:"configVersion"`
	UpdatedAt               *time.Time `json:"updatedAt,omitempty"`
	UpdatedByUsername       string     `json:"updatedByUsername,omitempty"`
}

type RTCConnection struct {
	Provider  string `json:"provider"`
	Token     string `json:"token"`
	URL       string `json:"url,omitempty"`
	RoomID    string `json:"roomId"`
	UserID    string `json:"userId"`
	Language  string `json:"language"`
	ExpiresAt string `json:"expiresAt"`
}

type Store struct {
	db  database.DBTX
	box *secretbox.Box
}

func NewStore(db database.DBTX, box *secretbox.Box) *Store {
	return &Store{db: db, box: box}
}

func wrapStore(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, ErrStore) {
		return err
	}
	return fmt.Errorf("%w: %v", ErrStore, err)
}

func (s *Store) DecryptAPIKey(record AIRecord) (string, error) {
	if len(record.EncryptedAPIKey) == 0 {
		return "", nil
	}
	if s.box == nil {
		return "", ErrMasterKeyMissing
	}
	plain, err := s.box.Open(record.EncryptedAPIKey)
	if err != nil {
		return "", ErrDecryptFailed
	}
	return string(plain), nil
}

func (s *Store) GetRTC(ctx context.Context) (RTCRecord, error) {
	record := RTCRecord{}
	err := s.db.QueryRow(ctx, `
		select
			c.language, c.enabled,
			coalesce(c.livekit_url, ''), coalesce(c.livekit_api_key, ''),
			c.encrypted_livekit_api_secret, coalesce(c.livekit_asr_base_url, ''),
			coalesce(c.livekit_asr_model, ''), c.encrypted_asr_api_key, c.livekit_key_version,
			coalesce(c.pipeline_mode, 'cascaded'),
			coalesce(c.asr_provider_id, ''), coalesce(c.asr_model_id, ''),
			coalesce(c.llm_provider_id, ''), coalesce(c.llm_model_id, ''),
			coalesce(c.tts_provider_id, ''), coalesce(c.tts_model_id, ''), coalesce(c.tts_voice_id, ''),
			coalesce(c.e2e_provider_id, ''), coalesce(c.e2e_model_id, ''),
			c.config_version, coalesce(c.updated_by_user_id, ''),
			coalesce(u.username, ''), c.created_at, c.updated_at
		from rtc_configs as c
		left join users as u on u.id = c.updated_by_user_id
		where c.id = $1
	`, singletonID).Scan(
		&record.Language,
		&record.Enabled,
		&record.LiveKitURL,
		&record.LiveKitAPIKey,
		&record.EncryptedLiveKitAPISecret,
		&record.LiveKitASRBaseURL,
		&record.LiveKitASRModel,
		&record.EncryptedASRAPIKey,
		&record.LiveKitKeyVersion,
		&record.PipelineMode,
		&record.ASRProviderID,
		&record.ASRModelID,
		&record.LLMProviderID,
		&record.LLMModelID,
		&record.TTSProviderID,
		&record.TTSModelID,
		&record.TTSVoiceID,
		&record.E2EProviderID,
		&record.E2EModelID,
		&record.ConfigVersion,
		&record.UpdatedByUserID,
		&record.UpdatedByUsername,
		&record.CreatedAt,
		&record.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return RTCRecord{}, ErrNotConfigured
	}
	if err != nil {
		return RTCRecord{}, ErrStore
	}
	if record.PipelineMode == "" {
		record.PipelineMode = PipelineModeCascaded
	}
	return record, nil
}

func (s *Store) PutRTC(ctx context.Context, actor users.User, input RTCInput) (RTCRecord, error) {
	current, currentErr := s.GetRTC(ctx)
	if currentErr != nil && !errors.Is(currentErr, ErrNotConfigured) {
		return RTCRecord{}, currentErr
	}
	merged := mergeRTCInput(input, current, currentErr == nil)
	normalized, err := normalizeRTCInput(merged)
	if err != nil {
		return RTCRecord{}, err
	}

	livekitSecret, livekitKeyVersion, err := s.sealOrKeep(normalized.ClearLiveKitSecret, normalized.LiveKitAPISecret, current.EncryptedLiveKitAPISecret, current.LiveKitKeyVersion)
	if err != nil {
		return RTCRecord{}, err
	}
	asrKey, asrKeyVersion, err := s.sealOrKeep(normalized.ClearASRAPIKey, normalized.ASRAPIKey, current.EncryptedASRAPIKey, current.LiveKitKeyVersion)
	if err != nil {
		return RTCRecord{}, err
	}
	if asrKeyVersion > livekitKeyVersion {
		livekitKeyVersion = asrKeyVersion
	}

	enabled := true
	if normalized.Enabled != nil {
		enabled = *normalized.Enabled
	} else if currentErr == nil {
		enabled = current.Enabled
	}

	if normalized.LiveKitURL == "" || normalized.LiveKitAPIKey == "" || len(livekitSecret) == 0 {
		return RTCRecord{}, ErrInvalidInput
	}

	now := time.Now().UTC().Truncate(time.Microsecond)
	configVersion := 1
	if currentErr == nil {
		configVersion = current.ConfigVersion + 1
	}

	var asrURL any
	if normalized.ASRBaseURL != "" {
		asrURL = normalized.ASRBaseURL
	}
	var asrModel any
	if normalized.ASRModel != "" {
		asrModel = normalized.ASRModel
	}

	_, err = s.db.Exec(ctx, `
		insert into rtc_configs (
			id, language, enabled, config_version, updated_by_user_id, created_at, updated_at,
			livekit_url, livekit_api_key, encrypted_livekit_api_secret,
			livekit_asr_base_url, livekit_asr_model, encrypted_asr_api_key, livekit_key_version,
			pipeline_mode, asr_provider_id, asr_model_id, llm_provider_id, llm_model_id,
			tts_provider_id, tts_model_id, tts_voice_id, e2e_provider_id, e2e_model_id
		) values ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
		on conflict (id) do update set
			language = excluded.language,
			enabled = excluded.enabled,
			config_version = excluded.config_version,
			updated_by_user_id = excluded.updated_by_user_id,
			updated_at = excluded.updated_at,
			livekit_url = excluded.livekit_url,
			livekit_api_key = excluded.livekit_api_key,
			encrypted_livekit_api_secret = excluded.encrypted_livekit_api_secret,
			livekit_asr_base_url = excluded.livekit_asr_base_url,
			livekit_asr_model = excluded.livekit_asr_model,
			encrypted_asr_api_key = excluded.encrypted_asr_api_key,
			livekit_key_version = excluded.livekit_key_version,
			pipeline_mode = excluded.pipeline_mode,
			asr_provider_id = excluded.asr_provider_id,
			asr_model_id = excluded.asr_model_id,
			llm_provider_id = excluded.llm_provider_id,
			llm_model_id = excluded.llm_model_id,
			tts_provider_id = excluded.tts_provider_id,
			tts_model_id = excluded.tts_model_id,
			tts_voice_id = excluded.tts_voice_id,
			e2e_provider_id = excluded.e2e_provider_id,
			e2e_model_id = excluded.e2e_model_id
	`, singletonID, normalized.Language, enabled, configVersion, actor.ID, now,
		normalized.LiveKitURL, normalized.LiveKitAPIKey, livekitSecret,
		asrURL, asrModel, asrKey, livekitKeyVersion,
		normalized.PipelineMode, normalized.ASRProviderID, normalized.ASRModelID,
		normalized.LLMProviderID, normalized.LLMModelID, normalized.TTSProviderID,
		normalized.TTSModelID, normalized.TTSVoiceID, normalized.E2EProviderID, normalized.E2EModelID)
	if err != nil {
		return RTCRecord{}, ErrStore
	}
	return s.GetRTC(ctx)
}

func (s *Store) sealOrKeep(clear bool, next string, current []byte, currentVersion int) ([]byte, int, error) {
	version := currentVersion
	if version == 0 {
		version = 1
	}
	if clear {
		return nil, version, nil
	}
	if strings.TrimSpace(next) == "" {
		return current, version, nil
	}
	if s.box == nil {
		return nil, 0, ErrMasterKeyMissing
	}
	sealed, err := s.box.Seal([]byte(strings.TrimSpace(next)))
	if err != nil {
		return nil, 0, err
	}
	return sealed, s.box.KeyVersion(), nil
}

func (s *Store) DecryptLiveKitSecret(record RTCRecord) (string, error) {
	return openOptional(s.box, record.EncryptedLiveKitAPISecret)
}

func (s *Store) DecryptASRAPIKey(record RTCRecord) (string, error) {
	return openOptional(s.box, record.EncryptedASRAPIKey)
}

func openOptional(box *secretbox.Box, sealed []byte) (string, error) {
	if len(sealed) == 0 {
		return "", nil
	}
	if box == nil {
		return "", ErrMasterKeyMissing
	}
	plain, err := box.Open(sealed)
	if err != nil {
		return "", ErrDecryptFailed
	}
	return string(plain), nil
}

func PublicAIFrom(record AIRecord, decryptErr error) PublicAI {
	local := isLocalEndpoint(record.BaseURL)
	keyConfigured := len(record.EncryptedAPIKey) > 0
	available := record.Enabled && record.Model != "" && record.BaseURL != "" && decryptErr == nil
	if !local && !keyConfigured {
		available = false
	}
	if decryptErr != nil {
		available = false
	}
	updated := record.UpdatedAt
	return PublicAI{
		Configured:        true,
		Available:         available,
		Provider:          record.Provider,
		BaseURL:           record.BaseURL,
		Model:             record.Model,
		QuestionTimeoutMs: record.QuestionTimeoutMs,
		ReportTimeoutMs:   record.ReportTimeoutMs,
		Enabled:           record.Enabled,
		APIKeyConfigured:  keyConfigured,
		LocalEndpoint:     local,
		ConfigVersion:     record.ConfigVersion,
		UpdatedAt:         &updated,
		UpdatedByUsername: record.UpdatedByUsername,
	}
}

func EmptyPublicAI() PublicAI {
	return PublicAI{
		Provider:          defaultProvider,
		QuestionTimeoutMs: defaultQuestionTimeout,
		ReportTimeoutMs:   defaultReportTimeout,
	}
}

func PublicRTCFrom(record RTCRecord, livekitDecryptErr error) PublicRTC {
	livekitSecretConfigured := len(record.EncryptedLiveKitAPISecret) > 0
	livekitConfigured := record.LiveKitURL != "" || record.LiveKitAPIKey != "" || livekitSecretConfigured
	livekitAvailable := record.LiveKitURL != "" && record.LiveKitAPIKey != "" && livekitSecretConfigured && livekitDecryptErr == nil
	if livekitDecryptErr != nil {
		livekitAvailable = false
	}
	available := record.Enabled && livekitAvailable
	updated := record.UpdatedAt
	return PublicRTC{
		Configured:              true,
		Available:               available,
		Provider:                ProviderLiveKit,
		Language:                record.Language,
		LiveKitURL:              record.LiveKitURL,
		LiveKitAPIKey:           record.LiveKitAPIKey,
		LiveKitSecretConfigured: livekitSecretConfigured,
		LiveKitConfigured:       livekitConfigured,
		LiveKitAvailable:        livekitAvailable && record.Enabled,
		ASRBaseURL:              record.LiveKitASRBaseURL,
		ASRModel:                record.LiveKitASRModel,
		ASRKeyConfigured:        len(record.EncryptedASRAPIKey) > 0,
		PipelineMode:            pipelineModeOrDefault(record.PipelineMode),
		ASRProviderID:           record.ASRProviderID,
		ASRModelID:              record.ASRModelID,
		LLMProviderID:           record.LLMProviderID,
		LLMModelID:              record.LLMModelID,
		TTSProviderID:           record.TTSProviderID,
		TTSModelID:              record.TTSModelID,
		TTSVoiceID:              record.TTSVoiceID,
		E2EProviderID:           record.E2EProviderID,
		E2EModelID:              record.E2EModelID,
		Enabled:                 record.Enabled,
		ConfigVersion:           record.ConfigVersion,
		UpdatedAt:               &updated,
		UpdatedByUsername:       record.UpdatedByUsername,
	}
}

func EmptyPublicRTC() PublicRTC {
	return PublicRTC{
		Language:     "zh",
		Provider:     ProviderLiveKit,
		PipelineMode: PipelineModeCascaded,
	}
}

func pipelineModeOrDefault(mode string) string {
	mode = strings.TrimSpace(mode)
	if mode == PipelineModeE2E {
		return PipelineModeE2E
	}
	return PipelineModeCascaded
}

func normalizeAIInput(input AIInput) (AIInput, error) {
	provider := strings.TrimSpace(input.Provider)
	if provider == "" {
		provider = defaultProvider
	}
	baseURL := strings.TrimSpace(input.BaseURL)
	model := strings.TrimSpace(input.Model)
	if provider != defaultProvider || baseURL == "" || model == "" {
		return AIInput{}, ErrInvalidInput
	}
	if utf8.RuneCountInString(provider) > 64 || utf8.RuneCountInString(baseURL) > 500 || utf8.RuneCountInString(model) > 200 {
		return AIInput{}, ErrInvalidInput
	}
	if !isSecureEndpoint(baseURL) {
		return AIInput{}, ErrInvalidInput
	}
	question := input.QuestionTimeoutMs
	if question == 0 {
		question = defaultQuestionTimeout
	}
	report := input.ReportTimeoutMs
	if report == 0 {
		report = defaultReportTimeout
	}
	if question < minTimeoutMs || question > maxTimeoutMs || report < minTimeoutMs || report > maxTimeoutMs {
		return AIInput{}, ErrInvalidInput
	}
	normalized, err := url.Parse(baseURL)
	if err != nil {
		return AIInput{}, ErrInvalidInput
	}
	normalized.Fragment = ""
	normalized.RawQuery = ""
	baseURL = strings.TrimRight(normalized.String(), "/")
	input.Provider = provider
	input.BaseURL = baseURL
	input.Model = model
	input.QuestionTimeoutMs = question
	input.ReportTimeoutMs = report
	return input, nil
}

func mergeRTCInput(input RTCInput, current RTCRecord, hasCurrent bool) RTCInput {
	if !hasCurrent {
		return input
	}
	if strings.TrimSpace(input.Language) == "" {
		input.Language = current.Language
	}
	if strings.TrimSpace(input.LiveKitURL) == "" {
		input.LiveKitURL = current.LiveKitURL
	}
	if strings.TrimSpace(input.LiveKitAPIKey) == "" {
		input.LiveKitAPIKey = current.LiveKitAPIKey
	}
	if strings.TrimSpace(input.ASRBaseURL) == "" {
		input.ASRBaseURL = current.LiveKitASRBaseURL
	}
	if strings.TrimSpace(input.ASRModel) == "" {
		input.ASRModel = current.LiveKitASRModel
	}
	if input.Enabled == nil {
		enabled := current.Enabled
		input.Enabled = &enabled
	}
	if strings.TrimSpace(input.PipelineMode) == "" {
		input.PipelineMode = current.PipelineMode
	}
	if strings.TrimSpace(input.ASRProviderID) == "" {
		input.ASRProviderID = current.ASRProviderID
	}
	if strings.TrimSpace(input.ASRModelID) == "" {
		input.ASRModelID = current.ASRModelID
	}
	if strings.TrimSpace(input.LLMProviderID) == "" {
		input.LLMProviderID = current.LLMProviderID
	}
	if strings.TrimSpace(input.LLMModelID) == "" {
		input.LLMModelID = current.LLMModelID
	}
	if strings.TrimSpace(input.TTSProviderID) == "" {
		input.TTSProviderID = current.TTSProviderID
	}
	if strings.TrimSpace(input.TTSModelID) == "" {
		input.TTSModelID = current.TTSModelID
	}
	if strings.TrimSpace(input.TTSVoiceID) == "" {
		input.TTSVoiceID = current.TTSVoiceID
	}
	if strings.TrimSpace(input.E2EProviderID) == "" {
		input.E2EProviderID = current.E2EProviderID
	}
	if strings.TrimSpace(input.E2EModelID) == "" {
		input.E2EModelID = current.E2EModelID
	}
	return input
}

func normalizeRTCInput(input RTCInput) (RTCInput, error) {
	language := strings.TrimSpace(input.Language)
	if language == "" {
		language = "zh"
	}
	if utf8.RuneCountInString(language) < 2 || utf8.RuneCountInString(language) > 20 {
		return RTCInput{}, ErrInvalidInput
	}
	livekitURL, err := normalizeLiveKitURL(strings.TrimSpace(input.LiveKitURL))
	if err != nil {
		return RTCInput{}, err
	}
	livekitKey := strings.TrimSpace(input.LiveKitAPIKey)
	if utf8.RuneCountInString(livekitKey) > 200 {
		return RTCInput{}, ErrInvalidInput
	}
	asrURL := strings.TrimSpace(input.ASRBaseURL)
	if asrURL != "" && !isSecureEndpoint(asrURL) {
		return RTCInput{}, ErrInvalidInput
	}
	asrModel := strings.TrimSpace(input.ASRModel)
	if utf8.RuneCountInString(asrURL) > 500 || utf8.RuneCountInString(asrModel) > 200 {
		return RTCInput{}, ErrInvalidInput
	}
	if livekitURL == "" || livekitKey == "" {
		return RTCInput{}, ErrInvalidInput
	}
	input.Language = language
	input.LiveKitURL = livekitURL
	input.LiveKitAPIKey = livekitKey
	input.ASRBaseURL = strings.TrimRight(asrURL, "/")
	input.ASRModel = asrModel
	input.PipelineMode = pipelineModeOrDefault(input.PipelineMode)
	input.ASRProviderID = strings.TrimSpace(input.ASRProviderID)
	input.ASRModelID = strings.TrimSpace(input.ASRModelID)
	input.LLMProviderID = strings.TrimSpace(input.LLMProviderID)
	input.LLMModelID = strings.TrimSpace(input.LLMModelID)
	input.TTSProviderID = strings.TrimSpace(input.TTSProviderID)
	input.TTSModelID = strings.TrimSpace(input.TTSModelID)
	input.TTSVoiceID = strings.TrimSpace(input.TTSVoiceID)
	input.E2EProviderID = strings.TrimSpace(input.E2EProviderID)
	input.E2EModelID = strings.TrimSpace(input.E2EModelID)
	return input, nil
}

func normalizeLiveKitURL(value string) (string, error) {
	if value == "" {
		return "", nil
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return "", ErrInvalidInput
	}
	switch parsed.Scheme {
	case "ws", "wss", "http", "https":
	default:
		return "", ErrInvalidInput
	}
	if utf8.RuneCountInString(value) > 500 {
		return "", ErrInvalidInput
	}
	return strings.TrimRight(parsed.String(), "/"), nil
}

func rtcIDPattern(value string) bool {
	if value == "" || utf8.RuneCountInString(value) > 128 {
		return false
	}
	for _, char := range value {
		if (char < 'A' || char > 'Z') && (char < 'a' || char > 'z') && (char < '0' || char > '9') && char != '_' && char != '-' {
			return false
		}
	}
	return true
}

func isSecureEndpoint(value string) bool {
	parsed, err := url.Parse(value)
	if err != nil {
		return false
	}
	if parsed.Scheme == "https" {
		return true
	}
	host := parsed.Hostname()
	return parsed.Scheme == "http" && (host == "127.0.0.1" || host == "localhost" || host == "::1")
}

func isLocalEndpoint(value string) bool {
	parsed, err := url.Parse(value)
	if err != nil {
		return false
	}
	host := parsed.Hostname()
	return host == "127.0.0.1" || host == "localhost" || host == "::1"
}

func AuditMetadata(configVersion int, available bool) map[string]any {
	return map[string]any{
		"configVersion": configVersion,
		"available":     available,
	}
}

type DiscoveredModel struct {
	ID                              string     `json:"id"`
	ProviderID                      string     `json:"providerId,omitempty"`
	ModelID                         string     `json:"modelId"`
	BaseURL                         string     `json:"baseUrl"`
	Enabled                         bool       `json:"enabled"`
	OwnedBy                         string     `json:"ownedBy,omitempty"`
	Capability                      string     `json:"capability,omitempty"`
	DisplayName                     string     `json:"displayName,omitempty"`
	ClassifiedBy                    string     `json:"classifiedBy,omitempty"`
	ClassifiedAt                    *time.Time `json:"classifiedAt,omitempty"`
	DiscoveredAt                    time.Time  `json:"discoveredAt"`
	UpdatedAt                       time.Time  `json:"updatedAt"`
	OfficialSupported               bool       `json:"officialSupported"`
	KeyDiscovered                   bool       `json:"keyDiscovered"`
	VerificationStatus              string     `json:"verificationStatus"`
	VerificationMessage             string     `json:"verificationMessage,omitempty"`
	VerifiedAt                      *time.Time `json:"verifiedAt,omitempty"`
	Protocol                        string     `json:"protocol,omitempty"`
	OfficialSyncedAt                *time.Time `json:"officialSyncedAt,omitempty"`
	RealtimeSupported               bool       `json:"realtimeSupported"`
	RealtimeEnabled                 bool       `json:"realtimeEnabled"`
	RealtimeVerificationStatus      string     `json:"realtimeVerificationStatus"`
	RealtimeVerificationMessage     string     `json:"realtimeVerificationMessage,omitempty"`
	RealtimeVerifiedAt              *time.Time `json:"realtimeVerifiedAt,omitempty"`
	RealtimeVerifiedProviderVersion int        `json:"realtimeVerifiedProviderVersion"`
}

const (
	CapabilityLLM     = "llm"
	CapabilityASR     = "asr"
	CapabilityTTS     = "tts"
	CapabilityE2E     = "e2e"
	CapabilityUnknown = "unknown"

	CatalogSpeechAliyun     = "speech:aliyun"
	CatalogSpeechVolcengine = "speech:volcengine"
)

func (s *Store) ListDiscoveredModels(ctx context.Context, baseURL string) ([]DiscoveredModel, error) {
	rows, err := s.db.Query(ctx, `
		select id, coalesce(provider_id, ''), model_id, base_url, enabled, coalesce(owned_by, ''),
		       coalesce(capability, 'unknown'), coalesce(display_name, ''), coalesce(classified_by, ''),
		       classified_at, discovered_at, updated_at,
		       realtime_enabled, realtime_verification_status, realtime_verification_message,
		       realtime_verified_at, realtime_verified_provider_version
		from discovered_models
		where base_url = $1
		order by model_id
	`, baseURL)
	if err != nil {
		return nil, wrapStore(err)
	}
	defer rows.Close()
	return scanDiscoveredModels(rows)
}

func (s *Store) UpsertDiscoveredModels(ctx context.Context, baseURL string, models []DiscoveredModel) error {
	providerID := ""
	if len(models) > 0 {
		providerID = strings.TrimSpace(models[0].ProviderID)
	}
	if providerID == "" {
		providers, err := s.ListAIProviders(ctx)
		if err != nil {
			return err
		}
		trimmed := strings.TrimRight(strings.TrimSpace(baseURL), "/")
		for _, p := range providers {
			if strings.TrimRight(p.BaseURL, "/") == trimmed {
				providerID = p.ID
				break
			}
		}
		if providerID == "" {
			providerID = "orphan:" + trimmed
		}
	}
	for _, m := range models {
		capability := catalogCapabilityForStore(m.Capability)
		if capability == CapabilityUnknown && strings.TrimSpace(m.Capability) == "" {
			capability = catalogCapabilityForStore(ClassifyModelID(m.ModelID))
		}
		classifiedBy := strings.TrimSpace(m.ClassifiedBy)
		if classifiedBy == "" {
			if capability == CapabilityUnknown {
				classifiedBy = ""
			} else {
				classifiedBy = "rules"
			}
		}
		pid := strings.TrimSpace(m.ProviderID)
		if pid == "" {
			pid = providerID
		}
		_, err := s.db.Exec(ctx, `
			insert into discovered_models (
				model_id, base_url, provider_id, owned_by, capability, display_name,
				classified_by, classified_at, enabled, discovered_at, updated_at
			) values ($1, $2, $3, $4, $5, $6, $7, case when $5 = 'unknown' then null else now() end, $8, now(), now())
			on conflict (provider_id, model_id) do update set
				base_url = excluded.base_url,
				owned_by = excluded.owned_by,
				capability = case
					when discovered_models.classified_by = 'manual' then discovered_models.capability
					when excluded.capability <> 'unknown' then excluded.capability
					else discovered_models.capability
				end,
				classified_by = case
					when discovered_models.classified_by = 'manual' then discovered_models.classified_by
					when excluded.capability <> 'unknown' then excluded.classified_by
					else discovered_models.classified_by
				end,
				classified_at = case
					when discovered_models.classified_by = 'manual' then discovered_models.classified_at
					when excluded.capability <> 'unknown' then now()
					else discovered_models.classified_at
				end,
				updated_at = now()
		`, m.ModelID, baseURL, pid, m.OwnedBy, capability, strings.TrimSpace(m.DisplayName), classifiedBy, m.Enabled)
		if err != nil {
			return wrapStore(err)
		}
	}
	return nil
}

func (s *Store) SetModelEnabled(ctx context.Context, baseURL, modelID string, enabled bool) error {
	tag, err := s.db.Exec(ctx, `
		update discovered_models
		set enabled = $1, realtime_enabled = case when $1 then realtime_enabled else false end, updated_at = now()
		where base_url = $2 and model_id = $3
	`, enabled, baseURL, modelID)
	if err != nil {
		return wrapStore(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrInvalidInput
	}
	return nil
}

func (s *Store) SetModelRealtime(ctx context.Context, providerID, modelID string, enabled bool, status, message string, verifiedAt *time.Time, providerVersion int) (DiscoveredModel, error) {
	tag, err := s.db.Exec(ctx, `
		update discovered_models
		set realtime_enabled=$1, realtime_verification_status=$2,
		    realtime_verification_message=$3, realtime_verified_at=$4,
		    realtime_verified_provider_version=$5, updated_at=now()
		where provider_id=$6 and model_id=$7 and enabled=true
	`, enabled, status, message, verifiedAt, providerVersion, providerID, modelID)
	if err != nil {
		return DiscoveredModel{}, wrapStore(err)
	}
	if tag.RowsAffected() == 0 {
		return DiscoveredModel{}, ErrModelNotVerified
	}
	return s.GetCatalogModel(ctx, providerID, modelID)
}

func (s *Store) InvalidateProviderRealtime(ctx context.Context, providerID, baseURL string) error {
	_, err := s.db.Exec(ctx, `
		update discovered_models
		set base_url=$2, realtime_enabled=false,
		    realtime_verification_status=case when realtime_verification_status='untested' then 'untested' else 'stale' end,
		    realtime_verification_message=case when realtime_verification_status='untested' then '' else 'PROVIDER_CONFIG_CHANGED' end,
		    updated_at=now()
		where provider_id=$1
	`, providerID, baseURL)
	return wrapStore(err)
}

func (s *Store) RefreshProviderRealtimeVersion(ctx context.Context, providerID string, providerVersion int) error {
	_, err := s.db.Exec(ctx, `
		update discovered_models set realtime_verified_provider_version=$2
		where provider_id=$1 and realtime_verification_status='verified'
	`, providerID, providerVersion)
	return wrapStore(err)
}

func (s *Store) GetEnabledModels(ctx context.Context, baseURL string) ([]string, error) {
	rows, err := s.db.Query(ctx, `
		select model_id from discovered_models
		where base_url = $1 and enabled = true
		order by model_id
	`, baseURL)
	if err != nil {
		return nil, wrapStore(err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, wrapStore(err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, wrapStore(err)
	}
	if ids == nil {
		ids = []string{}
	}
	return ids, nil
}
