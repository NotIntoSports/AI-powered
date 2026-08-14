package audit

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"testing"
	"time"

	"github.com/ai-interviewer/ai-powered/control-api/internal/database"
	"github.com/ai-interviewer/ai-powered/control-api/internal/users"
	"github.com/jackc/pgx/v5/pgxpool"
)

var auditSchemaPattern = regexp.MustCompile(`^control_api_audit_test_[a-f0-9]{32}$`)

func TestAppendPersistsAllowedEvent(t *testing.T) {
	pool := openAuditTestPool(t)
	userStore := users.NewStore(pool)
	store := NewStore(pool)
	ctx := context.Background()
	actor, err := userStore.Create(ctx, users.CreateInput{
		Username:     "audit-admin",
		PasswordHash: "encoded-password-hash",
		Role:         users.RoleAdmin,
	})
	if err != nil {
		t.Fatal(err)
	}

	event := Event{
		ActorUserID: actor.ID,
		Action:      ActionUserCreated,
		TargetType:  "user",
		TargetID:    "target-user",
		Result:      ResultSuccess,
		RequestID:   "request-123",
		SourceIP:    "127.0.0.1",
		Metadata: map[string]any{
			"role":        "operator",
			"retry_count": float64(0),
		},
	}
	if err := store.Append(ctx, event); err != nil {
		t.Fatal(err)
	}

	var (
		id          string
		action      Action
		actorUserID string
		metadataRaw []byte
		createdAt   time.Time
	)
	if err := pool.QueryRow(ctx, `
		select id, actor_user_id, action, metadata, created_at
		from audit_logs
		where request_id = $1
	`, event.RequestID).Scan(&id, &actorUserID, &action, &metadataRaw, &createdAt); err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^[a-f0-9]{32}$`).MatchString(id) || actorUserID != actor.ID || action != event.Action || createdAt.IsZero() {
		t.Fatalf("id=%q actor=%q action=%q createdAt=%v", id, actorUserID, action, createdAt)
	}
	var metadata map[string]any
	if err := json.Unmarshal(metadataRaw, &metadata); err != nil {
		t.Fatal(err)
	}
	if metadata["role"] != "operator" || metadata["retry_count"] != float64(0) {
		t.Fatalf("metadata = %#v", metadata)
	}
}

func TestAppendRejectsSensitiveMetadataKeysCaseInsensitively(t *testing.T) {
	store := NewStore(nil)
	for _, key := range []string{"password", "PASSWORD", "ToKeN", "secret", "Authorization", "API_KEY"} {
		t.Run(key, func(t *testing.T) {
			err := store.Append(context.Background(), validAuditEvent(map[string]any{key: "must-not-persist"}))
			if !errors.Is(err, ErrSensitiveMetadata) {
				t.Fatalf("error = %v, want ErrSensitiveMetadata", err)
			}
		})
	}
}

func TestAppendRejectsNestedSensitiveMetadataKey(t *testing.T) {
	store := NewStore(nil)
	err := store.Append(context.Background(), validAuditEvent(map[string]any{
		"request": map[string]any{"Token": "must-not-persist"},
	}))
	if !errors.Is(err, ErrSensitiveMetadata) {
		t.Fatalf("error = %v, want ErrSensitiveMetadata", err)
	}
}

func TestAppendAllowsNonMatchingMetadataKeys(t *testing.T) {
	pool := openAuditTestPool(t)
	store := NewStore(pool)
	event := validAuditEvent(map[string]any{
		"token_count": 2,
		"secretary":   "operator",
	})
	if err := store.Append(context.Background(), event); err != nil {
		t.Fatal(err)
	}
}

func TestAppendRejectsUnknownActionAndUnencodableMetadata(t *testing.T) {
	store := NewStore(nil)
	event := validAuditEvent(nil)
	event.Action = Action("unknown.action")
	if err := store.Append(context.Background(), event); !errors.Is(err, ErrInvalidAction) {
		t.Fatalf("unknown action error = %v", err)
	}

	event = validAuditEvent(map[string]any{"bad": make(chan int)})
	if err := store.Append(context.Background(), event); !errors.Is(err, ErrInvalidMetadata) {
		t.Fatalf("unencodable metadata error = %v", err)
	}
}

func validAuditEvent(metadata map[string]any) Event {
	return Event{
		Action:     ActionLoginFailed,
		TargetType: "user",
		Result:     ResultFailure,
		RequestID:  "request-validation",
		Metadata:   metadata,
	}
}

func openAuditTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set; skipping PostgreSQL integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	adminPool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open test PostgreSQL pool: %v", err)
	}
	if err := adminPool.Ping(ctx); err != nil {
		adminPool.Close()
		t.Fatalf("ping test PostgreSQL pool: %v", err)
	}
	t.Cleanup(adminPool.Close)

	schema := newAuditTestSchemaName(t)
	quotedSchema := quoteAuditTestSchema(t, schema)
	if _, err := adminPool.Exec(ctx, "create schema "+quotedSchema); err != nil {
		t.Fatalf("create test schema: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cleanupCancel()
		if _, err := adminPool.Exec(cleanupCtx, "drop schema "+quotedSchema+" cascade"); err != nil {
			t.Errorf("drop test schema %q: %v", schema, err)
		}
	})

	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatalf("parse test PostgreSQL pool configuration: %v", err)
	}
	if config.ConnConfig.RuntimeParams == nil {
		config.ConnConfig.RuntimeParams = make(map[string]string)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatalf("open schema-scoped test PostgreSQL pool: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Fatalf("ping schema-scoped test PostgreSQL pool: %v", err)
	}
	t.Cleanup(pool.Close)
	if err := database.Migrate(context.Background(), pool); err != nil {
		t.Fatalf("migrate test schema: %v", err)
	}
	return pool
}

func newAuditTestSchemaName(t *testing.T) string {
	t.Helper()
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		t.Fatalf("generate test schema name: %v", err)
	}
	return "control_api_audit_test_" + hex.EncodeToString(random)
}

func quoteAuditTestSchema(t *testing.T, schema string) string {
	t.Helper()
	if !auditSchemaPattern.MatchString(schema) {
		t.Fatalf("unsafe test schema name %q", schema)
	}
	return fmt.Sprintf(`"%s"`, schema)
}
