package settings

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/ai-interviewer/ai-powered/control-api/internal/database"
	"github.com/ai-interviewer/ai-powered/control-api/internal/secretbox"
	"github.com/ai-interviewer/ai-powered/control-api/internal/users"
	"github.com/jackc/pgx/v5/pgxpool"
)

var settingsSchemaPattern = regexp.MustCompile(`^control_api_settings_test_[a-f0-9]{32}$`)

func TestPutAIEncryptsKeyAndPublicViewOmitsSecret(t *testing.T) {
	pool := openSettingsTestPool(t)
	box := mustBox(t)
	store := NewStore(pool, box)
	ctx := context.Background()
	actor := createSettingsUser(t, pool)

	enabled := true
	record, err := store.PutAI(ctx, actor, AIInput{
		BaseURL:           "https://api.openai.com/v1",
		Model:             "gpt-4o-mini",
		QuestionTimeoutMs: 60000,
		ReportTimeoutMs:   180000,
		Enabled:           &enabled,
		APIKey:            "sk-test-secret",
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(record.EncryptedAPIKey), "sk-test-secret") {
		t.Fatal("api key stored in plaintext")
	}
	plain, err := store.DecryptAPIKey(record)
	if err != nil || plain != "sk-test-secret" {
		t.Fatalf("decrypt=%q err=%v", plain, err)
	}
	public := PublicAIFrom(record, nil)
	if !public.APIKeyConfigured || public.BaseURL != "https://api.openai.com/v1" || !public.Available {
		t.Fatalf("public=%#v", public)
	}
}

func TestPutAIKeepsExistingKeyWhenOmitted(t *testing.T) {
	pool := openSettingsTestPool(t)
	store := NewStore(pool, mustBox(t))
	ctx := context.Background()
	actor := createSettingsUser(t, pool)
	if _, err := store.PutAI(ctx, actor, AIInput{
		BaseURL: "https://api.openai.com/v1", Model: "one", APIKey: "first-key",
	}); err != nil {
		t.Fatal(err)
	}
	updated, err := store.PutAI(ctx, actor, AIInput{
		BaseURL: "https://api.openai.com/v1", Model: "two",
	})
	if err != nil {
		t.Fatal(err)
	}
	plain, err := store.DecryptAPIKey(updated)
	if err != nil || plain != "first-key" || updated.Model != "two" || updated.ConfigVersion != 2 {
		t.Fatalf("updated model=%s key=%s version=%d err=%v", updated.Model, plain, updated.ConfigVersion, err)
	}
}

func TestPutStorageEncryptsSecretKey(t *testing.T) {
	pool := openSettingsTestPool(t)
	store := NewStore(pool, mustBox(t))
	ctx := context.Background()
	actor := createSettingsUser(t, pool)
	enabled := true
	record, err := store.PutStorage(ctx, actor, StorageInput{
		Region:    "ap-guangzhou",
		Bucket:    "resume-1250000000",
		SecretID:  "AKIDexample",
		SecretKey: "super-secret-key",
		Enabled:   &enabled,
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(record.EncryptedSecretKey), "super-secret-key") {
		t.Fatal("secret key stored in plaintext")
	}
	plain, err := store.DecryptSecretKey(record)
	if err != nil || plain != "super-secret-key" {
		t.Fatalf("decrypt=%q err=%v", plain, err)
	}
	public := PublicStorageFrom(record, nil)
	if !public.SecretKeyConfigured || public.SecretID != "AKIDexample" || !public.Available {
		t.Fatalf("public=%#v", public)
	}
}

func TestPublicAINeverIncludesKeyMaterial(t *testing.T) {
	record := AIRecord{Provider: defaultProvider, BaseURL: "https://api.openai.com/v1", Model: "m", EncryptedAPIKey: []byte("cipher")}
	public := PublicAIFrom(record, nil)
	encoded := fmt.Sprintf("%#v %s", public, public.BaseURL)
	if strings.Contains(strings.ToLower(encoded), "cipher") || strings.Contains(strings.ToLower(encoded), "apikey") && strings.Contains(encoded, "sk-") {
		t.Fatalf("leaked: %s", encoded)
	}
}

func TestPutRTCRejectsHTTPTokenService(t *testing.T) {
	_, err := normalizeRTCInput(RTCInput{
		AppID: "app", Language: "zh", Mode: "production", TokenServiceURL: "http://example.com/token",
	})
	if err != ErrInvalidInput {
		t.Fatalf("err=%v", err)
	}
}

func TestPublicRTCAvailabilityFollowsActiveProvider(t *testing.T) {
	record := RTCRecord{
		Enabled:                   true,
		Language:                  "zh",
		Mode:                      "production",
		ActiveProvider:            ProviderLiveKit,
		LiveKitURL:                "ws://127.0.0.1:7880",
		LiveKitAPIKey:             "devkey",
		EncryptedLiveKitAPISecret: []byte("cipher"),
	}
	public := PublicRTCFrom(record, nil, nil)
	if !public.Available || !public.LiveKitAvailable || public.VolcengineAvailable || public.ActiveProvider != ProviderLiveKit {
		t.Fatalf("public=%#v", public)
	}
}

func TestPublicRTCDecryptErrorIsLimitedToThatProvider(t *testing.T) {
	record := RTCRecord{
		Enabled:                   true,
		Language:                  "zh",
		Mode:                      "production",
		ActiveProvider:            ProviderLiveKit,
		LiveKitURL:                "ws://127.0.0.1:7880",
		LiveKitAPIKey:             "devkey",
		EncryptedLiveKitAPISecret: []byte("cipher"),
	}
	public := PublicRTCFrom(record, ErrDecryptFailed, nil)
	if !public.Available || !public.LiveKitAvailable || public.VolcengineAvailable {
		t.Fatalf("public=%#v", public)
	}
}

func TestNormalizeRTCAllowsLiveKitWithoutVolcengineAppID(t *testing.T) {
	input, err := normalizeRTCInput(RTCInput{
		Language: "zh", Mode: "production", ActiveProvider: ProviderLiveKit,
		LiveKitURL: "wss://livekit.example.com", LiveKitAPIKey: "devkey", LiveKitAPISecret: "secret",
	})
	if err != nil || input.AppID != "" || input.LiveKitURL != "wss://livekit.example.com" {
		t.Fatalf("input=%#v err=%v", input, err)
	}
}

func TestNormalizeRTCRejectsSelectingLiveKitWithoutURL(t *testing.T) {
	_, err := normalizeRTCInput(RTCInput{Language: "zh", Mode: "production", ActiveProvider: ProviderLiveKit, LiveKitAPIKey: "devkey"})
	if err != ErrInvalidInput {
		t.Fatalf("err=%v", err)
	}
}

func TestPublicSpeechOmitsSecretsAndRequiresSpeakerForTTS(t *testing.T) {
	record := SpeechRecord{
		Enabled:              true,
		AppID:                "8358554445",
		SpeakerID:            "custom_zh_interviewer",
		TTSResourceID:        defaultTTSResourceID,
		ASRResourceID:        defaultASRResourceID,
		EncryptedAPIKey:      []byte("cipher-api"),
		EncryptedAccessToken: []byte("cipher-token"),
		EncryptedSecretKey:   []byte("cipher-secret"),
	}
	public := PublicSpeechFrom(record, nil)
	encoded := fmt.Sprintf("%#v", public)
	if strings.Contains(encoded, "cipher") {
		t.Fatalf("leaked: %s", encoded)
	}
	if !public.Available || !public.TTSAvailable || !public.ASRAvailable {
		t.Fatalf("public=%#v", public)
	}
	record.SpeakerID = ""
	public = PublicSpeechFrom(record, nil)
	if !public.Available || public.TTSAvailable || !public.ASRAvailable {
		t.Fatalf("without speaker=%#v", public)
	}
}

func TestValidSpeakerID(t *testing.T) {
	if !validSpeakerID("custom_zh_interviewer") || !validSpeakerID("S_abc12345") {
		t.Fatal("expected valid speaker ids")
	}
	if validSpeakerID("custom_speaker_id") || validSpeakerID("short") || validSpeakerID("_leading_underscore") {
		t.Fatal("expected invalid speaker ids")
	}
}

func TestPutSpeechKeepsExistingKeyWhenOmitted(t *testing.T) {
	pool := openSettingsTestPool(t)
	store := NewStore(pool, mustBox(t))
	ctx := context.Background()
	actor := createSettingsUser(t, pool)
	if _, err := store.PutSpeech(ctx, actor, SpeechInput{
		AppID: "8358554445", APIKey: "first-speech-key", SpeakerID: "custom_zh_interviewer",
	}); err != nil {
		t.Fatal(err)
	}
	updated, err := store.PutSpeech(ctx, actor, SpeechInput{AppID: "8358554445"})
	if err != nil {
		t.Fatal(err)
	}
	plain, err := store.DecryptSpeechAPIKey(updated)
	if err != nil || plain != "first-speech-key" || updated.SpeakerID != "custom_zh_interviewer" || updated.ConfigVersion != 2 {
		t.Fatalf("updated speaker=%s key=%s version=%d err=%v", updated.SpeakerID, plain, updated.ConfigVersion, err)
	}
}

func mustBox(t *testing.T) *secretbox.Box {
	t.Helper()
	key, err := secretbox.ParseMasterKey(strings.Repeat("ab", 32))
	if err != nil {
		t.Fatal(err)
	}
	box, err := secretbox.New(key)
	if err != nil {
		t.Fatal(err)
	}
	return box
}

func createSettingsUser(t *testing.T, pool *pgxpool.Pool) users.User {
	t.Helper()
	user, err := users.NewStore(pool).Create(context.Background(), users.CreateInput{
		Username: "settings-admin", PasswordHash: "hash", Role: users.RoleAdmin,
	})
	if err != nil {
		t.Fatal(err)
	}
	return user
}

func openSettingsTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set; skipping PostgreSQL integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	adminPool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(adminPool.Close)
	schema := newSettingsTestSchemaName(t)
	quoted := quoteSettingsTestSchema(t, schema)
	if _, err := adminPool.Exec(ctx, "create schema "+quoted); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := adminPool.Exec(cleanup, "drop schema "+quoted+" cascade"); err != nil {
			t.Errorf("drop test schema %q: %v", schema, err)
		}
	})
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	if config.ConnConfig.RuntimeParams == nil {
		config.ConnConfig.RuntimeParams = map[string]string{}
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := database.Migrate(context.Background(), pool); err != nil {
		t.Fatal(err)
	}
	return pool
}

func newSettingsTestSchemaName(t *testing.T) string {
	t.Helper()
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		t.Fatal(err)
	}
	return "control_api_settings_test_" + hex.EncodeToString(bytes)
}

func quoteSettingsTestSchema(t *testing.T, schema string) string {
	t.Helper()
	if !settingsSchemaPattern.MatchString(schema) {
		t.Fatalf("unsafe test schema name %q", schema)
	}
	return fmt.Sprintf("%q", schema)
}
