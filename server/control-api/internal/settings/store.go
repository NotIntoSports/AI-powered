// Package settings stores encrypted AI and RTC configuration for the control API.
package settings

import (
	"context"
	"errors"
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
	ErrInvalidInput              = errors.New("invalid settings input")
	ErrMasterKeyMissing          = secretbox.ErrUnavailable
	ErrDecryptFailed             = secretbox.ErrCiphertext
	ErrNotConfigured             = errors.New("settings are not configured")
	ErrStore                     = errors.New("settings store unavailable")
	ErrRTCUnavailable            = errors.New("rtc provider is not available")
	ErrVoiceAlreadyAllocated     = errors.New("voice already allocated")
	ErrVoiceAllocationInProgress = errors.New("voice allocation in progress")
	ErrVoiceAllocationToken      = errors.New("voice allocation token is invalid")
)

const (
	singletonID            = "default"
	defaultProvider        = "openai-compatible"
	defaultQuestionTimeout = 60_000
	defaultReportTimeout   = 180_000
	minTimeoutMs           = 1_000
	maxTimeoutMs           = 600_000
	ProviderVolcengine     = "volcengine"
	ProviderLiveKit        = "livekit"
	livekitTokenTTL        = time.Hour
)

type AIRecord struct {
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
	AppID                     string
	Language                  string
	Mode                      string
	TokenServiceURL           string
	EncryptedSecret           []byte
	TrialExpiresAt            *time.Time
	TrialRoomID               string
	TrialUserID               string
	Enabled                   bool
	ActiveProvider            string
	LiveKitURL                string
	LiveKitAPIKey             string
	EncryptedLiveKitAPISecret []byte
	LiveKitASRBaseURL         string
	LiveKitASRModel           string
	EncryptedASRAPIKey        []byte
	LiveKitKeyVersion         int
	KeyVersion                int
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
	AppID              string
	Language           string
	Mode               string
	TokenServiceURL    string
	Secret             string
	ClearSecret        bool
	TrialExpiresAt     string
	TrialRoomID        string
	TrialUserID        string
	Enabled            *bool
	ActiveProvider     string
	LiveKitURL         string
	LiveKitAPIKey      string
	LiveKitAPISecret   string
	ClearLiveKitSecret bool
	ASRBaseURL         string
	ASRModel           string
	ASRAPIKey          string
	ClearASRAPIKey     bool
	TestProvider       string
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
	ActiveProvider          string     `json:"activeProvider"`
	AppID                   string     `json:"appId"`
	Language                string     `json:"language"`
	Mode                    string     `json:"mode"`
	TokenServiceURL         string     `json:"tokenServiceUrl"`
	SecretConfigured        bool       `json:"secretConfigured"`
	TrialExpiresAt          *time.Time `json:"trialExpiresAt,omitempty"`
	TrialRoomID             string     `json:"trialRoomId"`
	TrialUserID             string     `json:"trialUserId"`
	VolcengineAvailable     bool       `json:"volcengineAvailable"`
	LiveKitURL              string     `json:"livekitUrl"`
	LiveKitAPIKey           string     `json:"livekitApiKey"`
	LiveKitSecretConfigured bool       `json:"livekitSecretConfigured"`
	LiveKitConfigured       bool       `json:"livekitConfigured"`
	LiveKitAvailable        bool       `json:"livekitAvailable"`
	ASRBaseURL              string     `json:"asrBaseUrl"`
	ASRModel                string     `json:"asrModel"`
	ASRKeyConfigured        bool       `json:"asrKeyConfigured"`
	Enabled                 bool       `json:"enabled"`
	ConfigVersion           int        `json:"configVersion"`
	UpdatedAt               *time.Time `json:"updatedAt,omitempty"`
	UpdatedByUsername       string     `json:"updatedByUsername,omitempty"`
}

type RTCConnection struct {
	Provider  string `json:"provider"`
	Token     string `json:"token"`
	AppID     string `json:"appId,omitempty"`
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

func (s *Store) GetAI(ctx context.Context) (AIRecord, error) {
	record := AIRecord{}
	var encrypted []byte
	var updatedBy *string
	var username *string
	err := s.db.QueryRow(ctx, `
		select
			c.provider, c.base_url, c.model, c.question_timeout_ms, c.report_timeout_ms,
			c.enabled, c.encrypted_api_key, c.key_version, c.config_version,
			coalesce(c.updated_by_user_id, ''), coalesce(u.username, ''),
			c.created_at, c.updated_at
		from ai_provider_configs as c
		left join users as u on u.id = c.updated_by_user_id
		where c.id = $1
	`, singletonID).Scan(
		&record.Provider,
		&record.BaseURL,
		&record.Model,
		&record.QuestionTimeoutMs,
		&record.ReportTimeoutMs,
		&record.Enabled,
		&encrypted,
		&record.KeyVersion,
		&record.ConfigVersion,
		&record.UpdatedByUserID,
		&record.UpdatedByUsername,
		&record.CreatedAt,
		&record.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return AIRecord{}, ErrNotConfigured
	}
	if err != nil {
		return AIRecord{}, ErrStore
	}
	record.EncryptedAPIKey = encrypted
	_ = updatedBy
	_ = username
	return record, nil
}

func (s *Store) PutAI(ctx context.Context, actor users.User, input AIInput) (AIRecord, error) {
	normalized, err := normalizeAIInput(input)
	if err != nil {
		return AIRecord{}, err
	}
	current, currentErr := s.GetAI(ctx)
	if currentErr != nil && !errors.Is(currentErr, ErrNotConfigured) {
		return AIRecord{}, currentErr
	}

	encrypted := current.EncryptedAPIKey
	keyVersion := current.KeyVersion
	if current.KeyVersion == 0 {
		keyVersion = 1
	}
	if normalized.ClearAPIKey {
		encrypted = nil
	} else if strings.TrimSpace(normalized.APIKey) != "" {
		if s.box == nil {
			return AIRecord{}, ErrMasterKeyMissing
		}
		sealed, sealErr := s.box.Seal([]byte(strings.TrimSpace(normalized.APIKey)))
		if sealErr != nil {
			return AIRecord{}, sealErr
		}
		encrypted = sealed
		keyVersion = s.box.KeyVersion()
	}

	enabled := true
	if normalized.Enabled != nil {
		enabled = *normalized.Enabled
	} else if currentErr == nil {
		enabled = current.Enabled
	}

	now := time.Now().UTC().Truncate(time.Microsecond)
	configVersion := 1
	if currentErr == nil {
		configVersion = current.ConfigVersion + 1
	}

	_, err = s.db.Exec(ctx, `
		insert into ai_provider_configs (
			id, provider, base_url, model, question_timeout_ms, report_timeout_ms,
			enabled, encrypted_api_key, key_version, config_version, updated_by_user_id,
			created_at, updated_at
		) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
		on conflict (id) do update set
			provider = excluded.provider,
			base_url = excluded.base_url,
			model = excluded.model,
			question_timeout_ms = excluded.question_timeout_ms,
			report_timeout_ms = excluded.report_timeout_ms,
			enabled = excluded.enabled,
			encrypted_api_key = excluded.encrypted_api_key,
			key_version = excluded.key_version,
			config_version = excluded.config_version,
			updated_by_user_id = excluded.updated_by_user_id,
			updated_at = excluded.updated_at
	`, singletonID, normalized.Provider, normalized.BaseURL, normalized.Model,
		normalized.QuestionTimeoutMs, normalized.ReportTimeoutMs, enabled,
		encrypted, keyVersion, configVersion, actor.ID, now)
	if err != nil {
		return AIRecord{}, ErrStore
	}
	return s.GetAI(ctx)
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
	var tokenURL *string
	var room *string
	var user *string
	err := s.db.QueryRow(ctx, `
		select
			c.app_id, c.language, c.mode, c.token_service_url, c.encrypted_secret,
			c.trial_expires_at, c.trial_room_id, c.trial_user_id, c.enabled,
			c.active_provider, coalesce(c.livekit_url, ''), coalesce(c.livekit_api_key, ''),
			c.encrypted_livekit_api_secret, coalesce(c.livekit_asr_base_url, ''),
			coalesce(c.livekit_asr_model, ''), c.encrypted_asr_api_key, c.livekit_key_version,
			c.key_version, c.config_version, coalesce(c.updated_by_user_id, ''),
			coalesce(u.username, ''), c.created_at, c.updated_at
		from rtc_configs as c
		left join users as u on u.id = c.updated_by_user_id
		where c.id = $1
	`, singletonID).Scan(
		&record.AppID,
		&record.Language,
		&record.Mode,
		&tokenURL,
		&record.EncryptedSecret,
		&record.TrialExpiresAt,
		&room,
		&user,
		&record.Enabled,
		&record.ActiveProvider,
		&record.LiveKitURL,
		&record.LiveKitAPIKey,
		&record.EncryptedLiveKitAPISecret,
		&record.LiveKitASRBaseURL,
		&record.LiveKitASRModel,
		&record.EncryptedASRAPIKey,
		&record.LiveKitKeyVersion,
		&record.KeyVersion,
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
	if tokenURL != nil {
		record.TokenServiceURL = *tokenURL
	}
	if room != nil {
		record.TrialRoomID = *room
	}
	if user != nil {
		record.TrialUserID = *user
	}
	if record.ActiveProvider == "" {
		record.ActiveProvider = ProviderVolcengine
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

	encrypted, keyVersion, err := s.sealOrKeep(normalized.ClearSecret, normalized.Secret, current.EncryptedSecret, current.KeyVersion)
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

	if normalized.ActiveProvider == ProviderLiveKit && (normalized.LiveKitURL == "" || normalized.LiveKitAPIKey == "" || len(livekitSecret) == 0) {
		return RTCRecord{}, ErrInvalidInput
	}
	if normalized.ActiveProvider == ProviderVolcengine && normalized.AppID == "" {
		return RTCRecord{}, ErrInvalidInput
	}

	now := time.Now().UTC().Truncate(time.Microsecond)
	configVersion := 1
	if currentErr == nil {
		configVersion = current.ConfigVersion + 1
	}

	var tokenURL any
	if normalized.TokenServiceURL != "" {
		tokenURL = normalized.TokenServiceURL
	}
	var trialExpires any
	var trialRoom any
	var trialUser any
	if normalized.Mode == "trial" {
		if normalized.TrialExpiresAt != "" {
			parsed, parseErr := time.Parse(time.RFC3339, normalized.TrialExpiresAt)
			if parseErr != nil {
				return RTCRecord{}, ErrInvalidInput
			}
			trialExpires = parsed.UTC()
		} else if current.TrialExpiresAt != nil && currentErr == nil {
			trialExpires = *current.TrialExpiresAt
		}
		if normalized.TrialRoomID != "" {
			trialRoom = normalized.TrialRoomID
		}
		if normalized.TrialUserID != "" {
			trialUser = normalized.TrialUserID
		}
	}
	var livekitURL any
	if normalized.LiveKitURL != "" {
		livekitURL = normalized.LiveKitURL
	}
	var livekitAPIKey any
	if normalized.LiveKitAPIKey != "" {
		livekitAPIKey = normalized.LiveKitAPIKey
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
			id, app_id, language, mode, token_service_url, encrypted_secret,
			trial_expires_at, trial_room_id, trial_user_id, enabled, key_version,
			config_version, updated_by_user_id, created_at, updated_at,
			active_provider, livekit_url, livekit_api_key, encrypted_livekit_api_secret,
			livekit_asr_base_url, livekit_asr_model, encrypted_asr_api_key, livekit_key_version
		) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$15,$16,$17,$18,$19,$20,$21,$22)
		on conflict (id) do update set
			app_id = excluded.app_id,
			language = excluded.language,
			mode = excluded.mode,
			token_service_url = excluded.token_service_url,
			encrypted_secret = excluded.encrypted_secret,
			trial_expires_at = excluded.trial_expires_at,
			trial_room_id = excluded.trial_room_id,
			trial_user_id = excluded.trial_user_id,
			enabled = excluded.enabled,
			key_version = excluded.key_version,
			config_version = excluded.config_version,
			updated_by_user_id = excluded.updated_by_user_id,
			updated_at = excluded.updated_at,
			active_provider = excluded.active_provider,
			livekit_url = excluded.livekit_url,
			livekit_api_key = excluded.livekit_api_key,
			encrypted_livekit_api_secret = excluded.encrypted_livekit_api_secret,
			livekit_asr_base_url = excluded.livekit_asr_base_url,
			livekit_asr_model = excluded.livekit_asr_model,
			encrypted_asr_api_key = excluded.encrypted_asr_api_key,
			livekit_key_version = excluded.livekit_key_version
	`, singletonID, normalized.AppID, normalized.Language, normalized.Mode, tokenURL,
		encrypted, trialExpires, trialRoom, trialUser, enabled, keyVersion,
		configVersion, actor.ID, now, normalized.ActiveProvider, livekitURL, livekitAPIKey,
		livekitSecret, asrURL, asrModel, asrKey, livekitKeyVersion)
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

func (s *Store) DecryptSecret(record RTCRecord) (string, error) {
	return openOptional(s.box, record.EncryptedSecret)
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

func PublicRTCFrom(record RTCRecord, volcDecryptErr, livekitDecryptErr error) PublicRTC {
	secretConfigured := len(record.EncryptedSecret) > 0
	volcengineAvailable := record.AppID != "" && volcDecryptErr == nil
	if record.Mode == "production" && record.TokenServiceURL == "" && !secretConfigured {
		volcengineAvailable = false
	}
	if record.Mode == "trial" && (!secretConfigured || record.TrialExpiresAt == nil || record.TrialExpiresAt.Before(time.Now()) || record.TrialRoomID == "" || record.TrialUserID == "") {
		volcengineAvailable = false
	}
	livekitSecretConfigured := len(record.EncryptedLiveKitAPISecret) > 0
	livekitConfigured := record.LiveKitURL != "" || record.LiveKitAPIKey != "" || livekitSecretConfigured
	livekitAvailable := record.LiveKitURL != "" && record.LiveKitAPIKey != "" && livekitSecretConfigured && livekitDecryptErr == nil
	if volcDecryptErr != nil {
		volcengineAvailable = false
	}
	if livekitDecryptErr != nil {
		livekitAvailable = false
	}
	active := record.ActiveProvider
	if active == "" {
		active = ProviderVolcengine
	}
	available := record.Enabled
	if active == ProviderLiveKit {
		available = available && livekitAvailable
	} else {
		available = available && volcengineAvailable
	}
	updated := record.UpdatedAt
	return PublicRTC{
		Configured:              true,
		Available:               available,
		ActiveProvider:          active,
		AppID:                   record.AppID,
		Language:                record.Language,
		Mode:                    record.Mode,
		TokenServiceURL:         record.TokenServiceURL,
		SecretConfigured:        secretConfigured,
		TrialExpiresAt:          record.TrialExpiresAt,
		TrialRoomID:             record.TrialRoomID,
		TrialUserID:             record.TrialUserID,
		VolcengineAvailable:     volcengineAvailable && record.Enabled,
		LiveKitURL:              record.LiveKitURL,
		LiveKitAPIKey:           record.LiveKitAPIKey,
		LiveKitSecretConfigured: livekitSecretConfigured,
		LiveKitConfigured:       livekitConfigured,
		LiveKitAvailable:        livekitAvailable && record.Enabled,
		ASRBaseURL:              record.LiveKitASRBaseURL,
		ASRModel:                record.LiveKitASRModel,
		ASRKeyConfigured:        len(record.EncryptedASRAPIKey) > 0,
		Enabled:                 record.Enabled,
		ConfigVersion:           record.ConfigVersion,
		UpdatedAt:               &updated,
		UpdatedByUsername:       record.UpdatedByUsername,
	}
}

func EmptyPublicRTC() PublicRTC {
	return PublicRTC{
		Language:       "zh",
		Mode:           "production",
		ActiveProvider: ProviderVolcengine,
	}
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
	if strings.TrimSpace(input.AppID) == "" {
		input.AppID = current.AppID
	}
	if strings.TrimSpace(input.Language) == "" {
		input.Language = current.Language
	}
	if strings.TrimSpace(input.Mode) == "" {
		input.Mode = current.Mode
	}
	if strings.TrimSpace(input.TokenServiceURL) == "" {
		input.TokenServiceURL = current.TokenServiceURL
	}
	if strings.TrimSpace(input.TrialRoomID) == "" {
		input.TrialRoomID = current.TrialRoomID
	}
	if strings.TrimSpace(input.TrialUserID) == "" {
		input.TrialUserID = current.TrialUserID
	}
	if strings.TrimSpace(input.TrialExpiresAt) == "" && current.TrialExpiresAt != nil {
		input.TrialExpiresAt = current.TrialExpiresAt.UTC().Format(time.RFC3339)
	}
	if strings.TrimSpace(input.ActiveProvider) == "" {
		input.ActiveProvider = current.ActiveProvider
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
	return input
}

func normalizeRTCInput(input RTCInput) (RTCInput, error) {
	appID := strings.TrimSpace(input.AppID)
	language := strings.TrimSpace(input.Language)
	mode := strings.TrimSpace(input.Mode)
	active := strings.TrimSpace(input.ActiveProvider)
	if language == "" {
		language = "zh"
	}
	if mode == "" {
		mode = "production"
	}
	if active == "" {
		active = ProviderVolcengine
	}
	if active != ProviderVolcengine && active != ProviderLiveKit {
		return RTCInput{}, ErrInvalidInput
	}
	if utf8.RuneCountInString(appID) > 200 || utf8.RuneCountInString(language) < 2 || utf8.RuneCountInString(language) > 20 {
		return RTCInput{}, ErrInvalidInput
	}
	if mode != "production" && mode != "trial" {
		return RTCInput{}, ErrInvalidInput
	}
	if active == ProviderVolcengine && appID == "" {
		return RTCInput{}, ErrInvalidInput
	}
	tokenURL := strings.TrimSpace(input.TokenServiceURL)
	if mode == "production" {
		if tokenURL != "" {
			parsed, err := url.Parse(tokenURL)
			if err != nil || parsed.Scheme != "https" {
				return RTCInput{}, ErrInvalidInput
			}
			tokenURL = strings.TrimRight(parsed.String(), "/")
		}
		input.TrialExpiresAt = ""
		input.TrialRoomID = ""
		input.TrialUserID = ""
	} else {
		tokenURL = ""
		room := strings.TrimSpace(input.TrialRoomID)
		user := strings.TrimSpace(input.TrialUserID)
		if active == ProviderVolcengine && (room == "" || user == "" || !rtcIDPattern(room) || !rtcIDPattern(user)) {
			return RTCInput{}, ErrInvalidInput
		}
		if room != "" && !rtcIDPattern(room) {
			return RTCInput{}, ErrInvalidInput
		}
		if user != "" && !rtcIDPattern(user) {
			return RTCInput{}, ErrInvalidInput
		}
		input.TrialRoomID = room
		input.TrialUserID = user
		if expires := strings.TrimSpace(input.TrialExpiresAt); expires != "" {
			parsed, err := time.Parse(time.RFC3339, expires)
			if err != nil || !parsed.After(time.Now()) {
				return RTCInput{}, ErrInvalidInput
			}
			input.TrialExpiresAt = parsed.UTC().Format(time.RFC3339)
		}
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
	if active == ProviderLiveKit && (livekitURL == "" || livekitKey == "") {
		return RTCInput{}, ErrInvalidInput
	}
	input.AppID = appID
	input.Language = language
	input.Mode = mode
	input.TokenServiceURL = tokenURL
	input.ActiveProvider = active
	input.LiveKitURL = livekitURL
	input.LiveKitAPIKey = livekitKey
	input.ASRBaseURL = strings.TrimRight(asrURL, "/")
	input.ASRModel = asrModel
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
