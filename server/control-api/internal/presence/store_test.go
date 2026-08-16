package presence

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"regexp"
	"testing"
	"time"

	"github.com/ai-interviewer/ai-powered/control-api/internal/database"
	"github.com/ai-interviewer/ai-powered/control-api/internal/sessions"
	"github.com/ai-interviewer/ai-powered/control-api/internal/users"
	"github.com/jackc/pgx/v5/pgxpool"
)

var presenceSchemaPattern = regexp.MustCompile(`^control_api_presence_test_[a-f0-9]{32}$`)

func TestListUserPresenceMarksRecentSessionsOnline(t *testing.T) {
	pool := openPresenceTestPool(t)
	ctx := context.Background()
	userStore := users.NewStore(pool)
	sessionStore := sessions.NewStore(pool)
	store := NewStore(pool)

	onlineUser, err := userStore.Create(ctx, users.CreateInput{
		Username: "online-user", PasswordHash: "hash", Role: users.RoleOperator,
	})
	if err != nil {
		t.Fatal(err)
	}
	offlineUser, err := userStore.Create(ctx, users.CreateInput{
		Username: "offline-user", PasswordHash: "hash", Role: users.RoleOperator,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := sessionStore.Create(ctx, sessions.CreateInput{
		UserID: onlineUser.ID, Purpose: sessions.PurposeDesktop, TTL: time.Hour,
	}); err != nil {
		t.Fatal(err)
	}
	raw, session, err := sessionStore.Create(ctx, sessions.CreateInput{
		UserID: offlineUser.ID, Purpose: sessions.PurposeBrowser, TTL: time.Hour,
	})
	if err != nil || raw == "" {
		t.Fatal(err)
	}
	stale := time.Now().UTC().Add(-time.Hour)
	if _, err := pool.Exec(ctx, `
		update user_sessions set created_at = $2, last_used_at = $2 where id = $1
	`, session.ID, stale); err != nil {
		t.Fatal(err)
	}

	listed, err := store.ListUserPresence(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !listed[onlineUser.ID].Online || listed[onlineUser.ID].ActiveSessionCount != 1 {
		t.Fatalf("online=%#v", listed[onlineUser.ID])
	}
	if listed[offlineUser.ID].Online || listed[offlineUser.ID].ActiveSessionCount != 1 {
		t.Fatalf("offline=%#v", listed[offlineUser.ID])
	}

	lines, err := store.ListLines(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 2 {
		t.Fatalf("lines=%d", len(lines))
	}
}

func openPresenceTestPool(t *testing.T) *pgxpool.Pool {
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

	schema := newPresenceTestSchemaName(t)
	quoted := quotePresenceTestSchema(t, schema)
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

func newPresenceTestSchemaName(t *testing.T) string {
	t.Helper()
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		t.Fatal(err)
	}
	return "control_api_presence_test_" + hex.EncodeToString(bytes)
}

func quotePresenceTestSchema(t *testing.T, schema string) string {
	t.Helper()
	if !presenceSchemaPattern.MatchString(schema) {
		t.Fatalf("unsafe test schema name %q", schema)
	}
	return fmt.Sprintf("%q", schema)
}
