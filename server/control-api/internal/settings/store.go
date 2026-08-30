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
	Language                  string
	Enabled                   bool
	LiveKitURL                string
	LiveKitAPIKey             string
	EncryptedLiveKitAPISecret []byte
	LiveKitASRBaseURL         string
	LiveKitASRModel           string
	EncryptedASRAPIKey        []byte
	LiveKitKeyVersion         int
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
	err := s.db.QueryRow(ctx, `
		select
			c.language, c.enabled,
			coalesce(c.livekit_url, ''), coalesce(c.livekit_api_key, ''),
			c.encrypted_livekit_api_secret, coalesce(c.livekit_asr_base_url, ''),
			coalesce(c.livekit_asr_model, ''), c.encrypted_asr_api_key, c.livekit_key_version,
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
			livekit_asr_base_url, livekit_asr_model, encrypted_asr_api_key, livekit_key_version
		) values ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11,$12,$13)
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
			livekit_key_version = excluded.livekit_key_version
	`, singletonID, normalized.Language, enabled, configVersion, actor.ID, now,
		normalized.LiveKitURL, normalized.LiveKitAPIKey, livekitSecret,
		asrURL, asrModel, asrKey, livekitKeyVersion)
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
		Enabled:                 record.Enabled,
		ConfigVersion:           record.ConfigVersion,
		UpdatedAt:               &updated,
		UpdatedByUsername:       record.UpdatedByUsername,
	}
}

func EmptyPublicRTC() PublicRTC {
	return PublicRTC{
		Language: "zh",
		Provider: ProviderLiveKit,
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
