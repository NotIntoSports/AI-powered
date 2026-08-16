package settings

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/ai-interviewer/ai-powered/control-api/internal/users"
	"github.com/jackc/pgx/v5"
)

const defaultStorageProvider = "tencent-cos"

type StorageRecord struct {
	Provider           string
	Region             string
	Bucket             string
	SecretID           string
	EncryptedSecretKey []byte
	Enabled            bool
	KeyVersion         int
	ConfigVersion      int
	UpdatedByUserID    string
	UpdatedByUsername  string
	CreatedAt          time.Time
	UpdatedAt          time.Time
}

type StorageInput struct {
	Provider       string
	Region         string
	Bucket         string
	SecretID       string
	SecretKey      string
	ClearSecretKey bool
	Enabled        *bool
}

type PublicStorage struct {
	Configured          bool       `json:"configured"`
	Available           bool       `json:"available"`
	Provider            string     `json:"provider"`
	Region              string     `json:"region"`
	Bucket              string     `json:"bucket"`
	SecretID            string     `json:"secretId"`
	SecretKeyConfigured bool       `json:"secretKeyConfigured"`
	Enabled             bool       `json:"enabled"`
	ConfigVersion       int        `json:"configVersion"`
	UpdatedAt           *time.Time `json:"updatedAt,omitempty"`
	UpdatedByUsername   string     `json:"updatedByUsername,omitempty"`
}

type StorageTestResult struct {
	Reachable bool     `json:"reachable"`
	Message   string   `json:"message"`
	Buckets   []Bucket `json:"buckets,omitempty"`
}

type Bucket struct {
	Name   string `json:"name"`
	Region string `json:"region"`
}

func (s *Store) GetStorage(ctx context.Context) (StorageRecord, error) {
	record := StorageRecord{}
	err := s.db.QueryRow(ctx, `
		select
			c.provider, c.region, c.bucket, c.secret_id, c.encrypted_secret_key,
			c.enabled, c.key_version, c.config_version, coalesce(c.updated_by_user_id, ''),
			coalesce(u.username, ''), c.created_at, c.updated_at
		from object_storage_configs as c
		left join users as u on u.id = c.updated_by_user_id
		where c.id = $1
	`, singletonID).Scan(
		&record.Provider,
		&record.Region,
		&record.Bucket,
		&record.SecretID,
		&record.EncryptedSecretKey,
		&record.Enabled,
		&record.KeyVersion,
		&record.ConfigVersion,
		&record.UpdatedByUserID,
		&record.UpdatedByUsername,
		&record.CreatedAt,
		&record.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return StorageRecord{}, ErrNotConfigured
	}
	if err != nil {
		return StorageRecord{}, ErrStore
	}
	return record, nil
}

func (s *Store) PutStorage(ctx context.Context, actor users.User, input StorageInput) (StorageRecord, error) {
	normalized, err := normalizeStorageInput(input)
	if err != nil {
		return StorageRecord{}, err
	}
	current, currentErr := s.GetStorage(ctx)
	if currentErr != nil && !errors.Is(currentErr, ErrNotConfigured) {
		return StorageRecord{}, currentErr
	}

	encrypted := current.EncryptedSecretKey
	keyVersion := current.KeyVersion
	if current.KeyVersion == 0 {
		keyVersion = 1
	}
	if normalized.ClearSecretKey {
		encrypted = nil
	} else if strings.TrimSpace(normalized.SecretKey) != "" {
		if s.box == nil {
			return StorageRecord{}, ErrMasterKeyMissing
		}
		sealed, sealErr := s.box.Seal([]byte(strings.TrimSpace(normalized.SecretKey)))
		if sealErr != nil {
			return StorageRecord{}, sealErr
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
		insert into object_storage_configs (
			id, provider, region, bucket, secret_id, encrypted_secret_key, enabled,
			key_version, config_version, updated_by_user_id, created_at, updated_at
		) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
		on conflict (id) do update set
			provider = excluded.provider,
			region = excluded.region,
			bucket = excluded.bucket,
			secret_id = excluded.secret_id,
			encrypted_secret_key = excluded.encrypted_secret_key,
			enabled = excluded.enabled,
			key_version = excluded.key_version,
			config_version = excluded.config_version,
			updated_by_user_id = excluded.updated_by_user_id,
			updated_at = excluded.updated_at
	`, singletonID, normalized.Provider, normalized.Region, normalized.Bucket,
		normalized.SecretID, encrypted, enabled, keyVersion, configVersion, actor.ID, now)
	if err != nil {
		return StorageRecord{}, ErrStore
	}
	return s.GetStorage(ctx)
}

func (s *Store) DecryptSecretKey(record StorageRecord) (string, error) {
	if len(record.EncryptedSecretKey) == 0 {
		return "", nil
	}
	if s.box == nil {
		return "", ErrMasterKeyMissing
	}
	plain, err := s.box.Open(record.EncryptedSecretKey)
	if err != nil {
		return "", ErrDecryptFailed
	}
	return string(plain), nil
}

func PublicStorageFrom(record StorageRecord, decryptErr error) PublicStorage {
	keyConfigured := len(record.EncryptedSecretKey) > 0
	available := record.Enabled &&
		record.Provider == defaultStorageProvider &&
		record.Region != "" &&
		record.Bucket != "" &&
		record.SecretID != "" &&
		keyConfigured &&
		decryptErr == nil
	updated := record.UpdatedAt
	return PublicStorage{
		Configured:          true,
		Available:           available,
		Provider:            record.Provider,
		Region:              record.Region,
		Bucket:              record.Bucket,
		SecretID:            record.SecretID,
		SecretKeyConfigured: keyConfigured,
		Enabled:             record.Enabled,
		ConfigVersion:       record.ConfigVersion,
		UpdatedAt:           &updated,
		UpdatedByUsername:   record.UpdatedByUsername,
	}
}

func EmptyPublicStorage() PublicStorage {
	return PublicStorage{
		Provider: defaultStorageProvider,
		Enabled:  true,
	}
}

func normalizeStorageInput(input StorageInput) (StorageInput, error) {
	provider := strings.TrimSpace(input.Provider)
	if provider == "" {
		provider = defaultStorageProvider
	}
	if provider != defaultStorageProvider {
		return StorageInput{}, ErrInvalidInput
	}
	region := strings.TrimSpace(input.Region)
	bucket := strings.TrimSpace(input.Bucket)
	secretID := strings.TrimSpace(input.SecretID)
	if utf8.RuneCountInString(region) > 64 || utf8.RuneCountInString(bucket) > 128 || utf8.RuneCountInString(secretID) > 128 {
		return StorageInput{}, ErrInvalidInput
	}
	if region != "" && !storageToken(region, true) {
		return StorageInput{}, ErrInvalidInput
	}
	if bucket != "" && !storageToken(bucket, true) {
		return StorageInput{}, ErrInvalidInput
	}
	if secretID != "" && !storageToken(secretID, false) {
		return StorageInput{}, ErrInvalidInput
	}
	input.Provider = provider
	input.Region = region
	input.Bucket = bucket
	input.SecretID = secretID
	return input, nil
}

func storageToken(value string, allowHyphen bool) bool {
	if value == "" {
		return false
	}
	for _, char := range value {
		if unicode.IsLetter(char) || unicode.IsDigit(char) || char == '_' {
			continue
		}
		if allowHyphen && char == '-' {
			continue
		}
		return false
	}
	return true
}
