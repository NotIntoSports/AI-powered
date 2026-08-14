package sessions

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/ai-interviewer/ai-powered/control-api/internal/database"
	"github.com/ai-interviewer/ai-powered/control-api/internal/users"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var sessionSchemaPattern = regexp.MustCompile(`^control_api_sessions_test_[a-f0-9]{32}$`)

func TestCreateStoresDigestNotRawToken(t *testing.T) {
	pool := openSessionTestPool(t)
	userStore := users.NewStore(pool)
	store := NewStore(pool)
	ctx := context.Background()
	user := createSessionTestUser(t, userStore, "digest-user")

	raw, session, err := store.Create(ctx, CreateInput{UserID: user.ID, Purpose: PurposeDesktop, TTL: time.Hour})
	if err != nil || len(raw) != 43 {
		t.Fatalf("raw length=%d err=%v", len(raw), err)
	}
	digest := loadStoredDigest(t, pool, session.ID)
	if bytes.Contains(digest, []byte(raw)) {
		t.Fatal("raw token persisted")
	}
	wantDigest := sha256.Sum256([]byte(raw))
	if !bytes.Equal(digest, wantDigest[:]) {
		t.Fatalf("stored digest = %x, want SHA-256(raw token)", digest)
	}
	if session.UserID != user.ID || session.Purpose != PurposeDesktop || !session.ExpiresAt.After(session.CreatedAt) {
		t.Fatalf("session = %#v", session)
	}
}

func TestAuthenticateRejectsDisabledUserAndRevokedSession(t *testing.T) {
	pool := openSessionTestPool(t)
	userStore := users.NewStore(pool)
	store := NewStore(pool)
	ctx := context.Background()
	user := createSessionTestUser(t, userStore, "disabled-user")

	raw, _, err := store.Create(ctx, CreateInput{UserID: user.ID, Purpose: PurposeDesktop, TTL: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	if err := userStore.SetStatus(ctx, user.ID, users.StatusDisabled); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Authenticate(ctx, raw, PurposeDesktop); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("disabled user: %v", err)
	}
	if err := userStore.SetStatus(ctx, user.ID, users.StatusActive); err != nil {
		t.Fatal(err)
	}
	raw, _, err = store.Create(ctx, CreateInput{UserID: user.ID, Purpose: PurposeDesktop, TTL: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.RevokeToken(ctx, raw); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Authenticate(ctx, raw, PurposeDesktop); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("revoked session: %v", err)
	}
}

func TestAuthenticateEnforcesPurposeExpiryAndTokenFormat(t *testing.T) {
	pool := openSessionTestPool(t)
	userStore := users.NewStore(pool)
	store := NewStore(pool)
	ctx := context.Background()
	user := createSessionTestUser(t, userStore, "purpose-user")

	raw, session, err := store.Create(ctx, CreateInput{UserID: user.ID, Purpose: PurposeBrowser, TTL: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Authenticate(ctx, raw, PurposeDesktop); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("purpose mismatch error = %v", err)
	}
	if _, _, err := store.Authenticate(ctx, "not-a-session-token", PurposeBrowser); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("malformed token error = %v", err)
	}

	now := time.Now().UTC().Truncate(time.Microsecond)
	if _, err := pool.Exec(ctx, `update user_sessions set created_at = $2, expires_at = $3 where id = $1`, session.ID, now.Add(-2*time.Hour), now.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Authenticate(ctx, raw, PurposeBrowser); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("expired session error = %v", err)
	}
}

func TestAuthenticateRequiresEnabledOwnedDevice(t *testing.T) {
	pool := openSessionTestPool(t)
	userStore := users.NewStore(pool)
	store := NewStore(pool)
	ctx := context.Background()
	owner := createSessionTestUser(t, userStore, "device-owner")
	other := createSessionTestUser(t, userStore, "other-owner")
	deviceID := "11111111111111111111111111111111"
	now := time.Now().UTC().Truncate(time.Microsecond)
	if _, err := pool.Exec(ctx, `
		insert into devices (id, user_id, client_version, operating_system, os_version, last_seen_at)
		values ($1, $2, $3, $4, $5, $6)
	`, deviceID, owner.ID, "1.0.0", "windows", "11", now); err != nil {
		t.Fatal(err)
	}

	raw, _, err := store.Create(ctx, CreateInput{UserID: owner.ID, Purpose: PurposeDesktop, DeviceID: deviceID, TTL: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Authenticate(ctx, raw, PurposeDesktop); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `delete from devices where id = $1`, deviceID); err == nil {
		t.Fatal("deleted a device while a session was still bound to it")
	}
	var deviceStillExists bool
	if err := pool.QueryRow(ctx, `select exists(select 1 from devices where id = $1)`, deviceID).Scan(&deviceStillExists); err != nil || !deviceStillExists {
		t.Fatalf("deviceStillExists=%v err=%v", deviceStillExists, err)
	}
	if _, err := pool.Exec(ctx, `update devices set disabled_at = $2 where id = $1`, deviceID, now); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Authenticate(ctx, raw, PurposeDesktop); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("disabled device error = %v", err)
	}
	if _, _, err := store.Create(ctx, CreateInput{UserID: other.ID, Purpose: PurposeDesktop, DeviceID: deviceID, TTL: time.Hour}); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("foreign device error = %v", err)
	}
}

func TestAuthenticateThrottlesLastUsedUpdates(t *testing.T) {
	pool := openSessionTestPool(t)
	userStore := users.NewStore(pool)
	store := NewStore(pool)
	ctx := context.Background()
	user := createSessionTestUser(t, userStore, "throttle-user")
	raw, session, err := store.Create(ctx, CreateInput{UserID: user.ID, Purpose: PurposeDesktop, TTL: time.Hour})
	if err != nil {
		t.Fatal(err)
	}

	_, firstSession, err := store.Authenticate(ctx, raw, PurposeDesktop)
	if err != nil || firstSession.LastUsedAt == nil {
		t.Fatalf("first authenticate session=%#v err=%v", firstSession, err)
	}
	first := loadLastUsed(t, pool, session.ID)
	_, secondSession, err := store.Authenticate(ctx, raw, PurposeDesktop)
	if err != nil {
		t.Fatal(err)
	}
	second := loadLastUsed(t, pool, session.ID)
	if !second.Equal(first) || secondSession.LastUsedAt == nil || !secondSession.LastUsedAt.Equal(first) {
		t.Fatalf("last_used_at changed inside throttle window: first=%v second=%v returned=%v", first, second, secondSession.LastUsedAt)
	}

	backdated := first.Add(-6 * time.Minute)
	if _, err := pool.Exec(ctx, `update user_sessions set last_used_at = $2 where id = $1`, session.ID, backdated); err != nil {
		t.Fatal(err)
	}
	_, refreshed, err := store.Authenticate(ctx, raw, PurposeDesktop)
	if err != nil || refreshed.LastUsedAt == nil || !refreshed.LastUsedAt.After(backdated) {
		t.Fatalf("refreshed session=%#v err=%v", refreshed, err)
	}
}

func TestRevokeUserExceptPreservesMatchingSession(t *testing.T) {
	pool := openSessionTestPool(t)
	userStore := users.NewStore(pool)
	store := NewStore(pool)
	ctx := context.Background()
	user := createSessionTestUser(t, userStore, "except-user")
	keep, keepSession, err := store.Create(ctx, CreateInput{UserID: user.ID, Purpose: PurposeDesktop, TTL: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	drop, dropSession, err := store.Create(ctx, CreateInput{UserID: user.ID, Purpose: PurposeDesktop, TTL: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.RevokeUserExcept(ctx, user.ID, keepSession.ID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Authenticate(ctx, keep, PurposeDesktop); err != nil {
		t.Fatalf("preserved session: %v", err)
	}
	if _, _, err := store.Authenticate(ctx, drop, PurposeDesktop); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("dropped session %s error = %v", dropSession.ID, err)
	}
}

func TestStoresComposeInsideTransactionForPasswordAndStatusRevocation(t *testing.T) {
	pool := openSessionTestPool(t)
	ctx := context.Background()
	baseUsers := users.NewStore(pool)
	baseSessions := NewStore(pool)
	passwordUser := createSessionTestUser(t, baseUsers, "password-transaction")
	statusUser := createSessionTestUser(t, baseUsers, "status-transaction")
	passwordToken, passwordSession, err := baseSessions.Create(ctx, CreateInput{UserID: passwordUser.ID, Purpose: PurposeDesktop, TTL: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	statusToken, statusSession, err := baseSessions.Create(ctx, CreateInput{UserID: statusUser.ID, Purpose: PurposeDesktop, TTL: time.Hour})
	if err != nil {
		t.Fatal(err)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	txUsers := users.NewStore(tx)
	txSessions := NewStore(tx)
	if err := txUsers.ReplacePassword(ctx, passwordUser.ID, "new-encoded-hash"); err != nil {
		t.Fatal(err)
	}
	if err := txSessions.RevokeUser(ctx, passwordUser.ID); err != nil {
		t.Fatal(err)
	}
	if err := txUsers.SetStatus(ctx, statusUser.ID, users.StatusDisabled); err != nil {
		t.Fatal(err)
	}
	if err := txSessions.RevokeUser(ctx, statusUser.ID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	for raw, sessionID := range map[string]string{passwordToken: passwordSession.ID, statusToken: statusSession.ID} {
		if _, _, err := baseSessions.Authenticate(ctx, raw, PurposeDesktop); !errors.Is(err, ErrUnauthenticated) {
			t.Fatalf("session %s authenticate error = %v", sessionID, err)
		}
		var revokedAt *time.Time
		if err := pool.QueryRow(ctx, `select revoked_at from user_sessions where id = $1`, sessionID).Scan(&revokedAt); err != nil || revokedAt == nil {
			t.Fatalf("session %s revokedAt=%v err=%v", sessionID, revokedAt, err)
		}
	}
}

func TestAuthenticateTranslatesDatabaseFailureToStableError(t *testing.T) {
	store := NewStore(failingSessionDB{err: errors.New("SQLSTATE 99999 from user_sessions query")})
	raw := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	_, _, err := store.Authenticate(context.Background(), raw, PurposeDesktop)
	if !errors.Is(err, ErrStore) {
		t.Fatalf("error = %v, want ErrStore", err)
	}
	if strings.Contains(err.Error(), "SQLSTATE") {
		t.Fatalf("database details leaked: %v", err)
	}
}

type failingSessionDB struct {
	err error
}

func (db failingSessionDB) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, db.err
}

func (db failingSessionDB) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, db.err
}

func (db failingSessionDB) QueryRow(context.Context, string, ...any) pgx.Row {
	return failingSessionRow{err: db.err}
}

func (db failingSessionDB) Begin(context.Context) (pgx.Tx, error) {
	return nil, db.err
}

type failingSessionRow struct {
	err error
}

func (row failingSessionRow) Scan(...any) error {
	return row.err
}

func createSessionTestUser(t *testing.T, store *users.Store, username string) users.User {
	t.Helper()
	user, err := store.Create(context.Background(), users.CreateInput{
		Username:     username,
		PasswordHash: "encoded-password-hash",
		Role:         users.RoleOperator,
	})
	if err != nil {
		t.Fatal(err)
	}
	return user
}

func loadStoredDigest(t *testing.T, pool *pgxpool.Pool, sessionID string) []byte {
	t.Helper()
	var digest []byte
	if err := pool.QueryRow(context.Background(), `select token_digest from user_sessions where id = $1`, sessionID).Scan(&digest); err != nil {
		t.Fatal(err)
	}
	return digest
}

func loadLastUsed(t *testing.T, pool *pgxpool.Pool, sessionID string) time.Time {
	t.Helper()
	var lastUsed time.Time
	if err := pool.QueryRow(context.Background(), `select last_used_at from user_sessions where id = $1`, sessionID).Scan(&lastUsed); err != nil {
		t.Fatal(err)
	}
	return lastUsed
}

func openSessionTestPool(t *testing.T) *pgxpool.Pool {
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

	schema := newSessionTestSchemaName(t)
	quotedSchema := quoteSessionTestSchema(t, schema)
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

func newSessionTestSchemaName(t *testing.T) string {
	t.Helper()
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		t.Fatalf("generate test schema name: %v", err)
	}
	return "control_api_sessions_test_" + hex.EncodeToString(random)
}

func quoteSessionTestSchema(t *testing.T, schema string) string {
	t.Helper()
	if !sessionSchemaPattern.MatchString(schema) {
		t.Fatalf("unsafe test schema name %q", schema)
	}
	return fmt.Sprintf(`"%s"`, schema)
}
