package settings

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/ai-interviewer/ai-powered/control-api/internal/users"
	"github.com/jackc/pgx/v5"
)

const (
	defaultTTSResourceID = "seed-icl-2.0"
	defaultASRResourceID = "volc.bigasr.auc_turbo"
)

type SpeechRecord struct {
	AppID                 string
	SpeakerID             string
	TTSResourceID         string
	ASRResourceID         string
	Enabled               bool
	EncryptedAPIKey       []byte
	EncryptedAccessToken  []byte
	EncryptedSecretKey    []byte
	KeyVersion            int
	ConfigVersion         int
	UpdatedByUserID       string
	UpdatedByUsername     string
	CreatedAt             time.Time
	UpdatedAt             time.Time
}

type SpeechInput struct {
	AppID              string
	SpeakerID          string
	TTSResourceID      string
	ASRResourceID      string
	APIKey             string
	AccessToken        string
	SecretKey          string
	ClearAPIKey        bool
	ClearAccessToken   bool
	ClearSecretKey     bool
	Enabled            *bool
}

type PublicSpeech struct {
	Configured            bool       `json:"configured"`
	Available             bool       `json:"available"`
	TTSAvailable          bool       `json:"ttsAvailable"`
	ASRAvailable          bool       `json:"asrAvailable"`
	AppID                 string     `json:"appId"`
	SpeakerID             string     `json:"speakerId"`
	TTSResourceID         string     `json:"ttsResourceId"`
	ASRResourceID         string     `json:"asrResourceId"`
	APIKeyConfigured      bool       `json:"apiKeyConfigured"`
	AccessTokenConfigured bool       `json:"accessTokenConfigured"`
	SecretKeyConfigured   bool       `json:"secretKeyConfigured"`
	Enabled               bool       `json:"enabled"`
	ConfigVersion         int        `json:"configVersion"`
	UpdatedAt             *time.Time `json:"updatedAt,omitempty"`
	UpdatedByUsername     string     `json:"updatedByUsername,omitempty"`
}

type ClientSpeech struct {
	PublicSpeech
	APIKey      string `json:"apiKey,omitempty"`
	AccessToken string `json:"accessToken,omitempty"`
}

type SpeechTestResult struct {
	Reachable bool   `json:"reachable"`
	Message   string `json:"message"`
}

func (s *Store) GetSpeech(ctx context.Context) (SpeechRecord, error) {
	record := SpeechRecord{}
	err := s.db.QueryRow(ctx, `
		select
			c.app_id, c.speaker_id, c.tts_resource_id, c.asr_resource_id, c.enabled,
			c.encrypted_api_key, c.encrypted_access_token, c.encrypted_secret_key,
			c.key_version, c.config_version, coalesce(c.updated_by_user_id, ''),
			coalesce(u.username, ''), c.created_at, c.updated_at
		from speech_configs as c
		left join users as u on u.id = c.updated_by_user_id
		where c.id = $1
	`, singletonID).Scan(
		&record.AppID,
		&record.SpeakerID,
		&record.TTSResourceID,
		&record.ASRResourceID,
		&record.Enabled,
		&record.EncryptedAPIKey,
		&record.EncryptedAccessToken,
		&record.EncryptedSecretKey,
		&record.KeyVersion,
		&record.ConfigVersion,
		&record.UpdatedByUserID,
		&record.UpdatedByUsername,
		&record.CreatedAt,
		&record.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return SpeechRecord{}, ErrNotConfigured
	}
	if err != nil {
		return SpeechRecord{}, ErrStore
	}
	return record, nil
}

func (s *Store) PutSpeech(ctx context.Context, actor users.User, input SpeechInput) (SpeechRecord, error) {
	normalized, err := normalizeSpeechInput(input)
	if err != nil {
		return SpeechRecord{}, err
	}
	current, currentErr := s.GetSpeech(ctx)
	if currentErr != nil && !errors.Is(currentErr, ErrNotConfigured) {
		return SpeechRecord{}, currentErr
	}

	apiKey, keyVersion, err := s.sealOrKeep(normalized.ClearAPIKey, normalized.APIKey, current.EncryptedAPIKey, current.KeyVersion)
	if err != nil {
		return SpeechRecord{}, err
	}
	accessToken, tokenVersion, err := s.sealOrKeep(normalized.ClearAccessToken, normalized.AccessToken, current.EncryptedAccessToken, keyVersion)
	if err != nil {
		return SpeechRecord{}, err
	}
	secretKey, secretVersion, err := s.sealOrKeep(normalized.ClearSecretKey, normalized.SecretKey, current.EncryptedSecretKey, tokenVersion)
	if err != nil {
		return SpeechRecord{}, err
	}
	if tokenVersion > keyVersion {
		keyVersion = tokenVersion
	}
	if secretVersion > keyVersion {
		keyVersion = secretVersion
	}

	if normalized.SpeakerID == "" && currentErr == nil {
		normalized.SpeakerID = current.SpeakerID
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
		insert into speech_configs (
			id, app_id, speaker_id, tts_resource_id, asr_resource_id, enabled,
			encrypted_api_key, encrypted_access_token, encrypted_secret_key,
			key_version, config_version, updated_by_user_id, created_at, updated_at
		) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
		on conflict (id) do update set
			app_id = excluded.app_id,
			speaker_id = excluded.speaker_id,
			tts_resource_id = excluded.tts_resource_id,
			asr_resource_id = excluded.asr_resource_id,
			enabled = excluded.enabled,
			encrypted_api_key = excluded.encrypted_api_key,
			encrypted_access_token = excluded.encrypted_access_token,
			encrypted_secret_key = excluded.encrypted_secret_key,
			key_version = excluded.key_version,
			config_version = excluded.config_version,
			updated_by_user_id = excluded.updated_by_user_id,
			updated_at = excluded.updated_at
	`, singletonID, normalized.AppID, normalized.SpeakerID, normalized.TTSResourceID,
		normalized.ASRResourceID, enabled, apiKey, accessToken, secretKey,
		keyVersion, configVersion, actor.ID, now)
	if err != nil {
		return SpeechRecord{}, ErrStore
	}
	return s.GetSpeech(ctx)
}

func (s *Store) PutSpeechSpeakerID(ctx context.Context, speakerID string) (SpeechRecord, error) {
	normalized := strings.TrimSpace(speakerID)
	if normalized == "" || !validSpeakerID(normalized) {
		return SpeechRecord{}, ErrInvalidInput
	}
	current, err := s.GetSpeech(ctx)
	if err != nil {
		return SpeechRecord{}, err
	}
	now := time.Now().UTC().Truncate(time.Microsecond)
	_, err = s.db.Exec(ctx, `
		update speech_configs
		set speaker_id = $2, config_version = config_version + 1, updated_at = $3
		where id = $1
	`, singletonID, normalized, now)
	if err != nil {
		return SpeechRecord{}, ErrStore
	}
	current.SpeakerID = normalized
	current.ConfigVersion++
	current.UpdatedAt = now
	return current, nil
}

func (s *Store) DecryptSpeechAPIKey(record SpeechRecord) (string, error) {
	return openOptional(s.box, record.EncryptedAPIKey)
}

func (s *Store) DecryptSpeechAccessToken(record SpeechRecord) (string, error) {
	return openOptional(s.box, record.EncryptedAccessToken)
}

func (s *Store) DecryptSpeechSecretKey(record SpeechRecord) (string, error) {
	return openOptional(s.box, record.EncryptedSecretKey)
}

func PublicSpeechFrom(record SpeechRecord, decryptErr error) PublicSpeech {
	apiKeyConfigured := len(record.EncryptedAPIKey) > 0
	accessTokenConfigured := len(record.EncryptedAccessToken) > 0
	available := record.Enabled && decryptErr == nil && (apiKeyConfigured || (record.AppID != "" && accessTokenConfigured))
	if decryptErr != nil {
		available = false
	}
	updated := record.UpdatedAt
	return PublicSpeech{
		Configured:            true,
		Available:             available,
		TTSAvailable:          available && record.SpeakerID != "",
		ASRAvailable:          available,
		AppID:                 record.AppID,
		SpeakerID:             record.SpeakerID,
		TTSResourceID:         record.TTSResourceID,
		ASRResourceID:         record.ASRResourceID,
		APIKeyConfigured:      apiKeyConfigured,
		AccessTokenConfigured: accessTokenConfigured,
		SecretKeyConfigured:   len(record.EncryptedSecretKey) > 0,
		Enabled:               record.Enabled,
		ConfigVersion:         record.ConfigVersion,
		UpdatedAt:             &updated,
		UpdatedByUsername:     record.UpdatedByUsername,
	}
}

func EmptyPublicSpeech() PublicSpeech {
	return PublicSpeech{
		TTSResourceID: defaultTTSResourceID,
		ASRResourceID: defaultASRResourceID,
		Enabled:       true,
	}
}

func normalizeSpeechInput(input SpeechInput) (SpeechInput, error) {
	normalized := SpeechInput{
		AppID:            strings.TrimSpace(input.AppID),
		SpeakerID:        strings.TrimSpace(input.SpeakerID),
		TTSResourceID:    strings.TrimSpace(input.TTSResourceID),
		ASRResourceID:    strings.TrimSpace(input.ASRResourceID),
		APIKey:           strings.TrimSpace(input.APIKey),
		AccessToken:      strings.TrimSpace(input.AccessToken),
		SecretKey:        strings.TrimSpace(input.SecretKey),
		ClearAPIKey:      input.ClearAPIKey,
		ClearAccessToken: input.ClearAccessToken,
		ClearSecretKey:   input.ClearSecretKey,
		Enabled:          input.Enabled,
	}
	if utf8.RuneCountInString(normalized.AppID) > 200 {
		return SpeechInput{}, ErrInvalidInput
	}
	if normalized.SpeakerID != "" && !validSpeakerID(normalized.SpeakerID) {
		return SpeechInput{}, ErrInvalidInput
	}
	if normalized.TTSResourceID == "" {
		normalized.TTSResourceID = defaultTTSResourceID
	}
	if normalized.ASRResourceID == "" {
		normalized.ASRResourceID = defaultASRResourceID
	}
	if utf8.RuneCountInString(normalized.TTSResourceID) > 128 || utf8.RuneCountInString(normalized.ASRResourceID) > 128 {
		return SpeechInput{}, ErrInvalidInput
	}
	return normalized, nil
}

func validSpeakerID(value string) bool {
	if value == "" {
		return true
	}
	if strings.EqualFold(value, "custom_speaker_id") {
		return false
	}
	n := utf8.RuneCountInString(value)
	if n < 8 || n > 256 {
		return false
	}
	runes := []rune(value)
	if runes[0] < 'A' || (runes[0] > 'Z' && runes[0] < 'a') || runes[0] > 'z' {
		return false
	}
	if runes[0] == '-' || runes[len(runes)-1] == '-' || runes[0] == '_' || runes[len(runes)-1] == '_' {
		return false
	}
	for _, r := range runes {
		if (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			continue
		}
		return false
	}
	return true
}
