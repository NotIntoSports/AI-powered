package database

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestMigrateCreatesIdentityTables(t *testing.T) {
	testPool := openTestPool(t)
	var versionTableExists bool
	if err := testPool.QueryRow(context.Background(), `select to_regclass($1 || '.goose_db_version') is not null`, testPool.schema).Scan(&versionTableExists); err != nil {
		t.Fatalf("check fresh schema: %v", err)
	}
	if versionTableExists {
		t.Fatal("test schema already has Goose migration state")
	}

	if err := Migrate(context.Background(), testPool.Pool); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(context.Background(), testPool.Pool); err != nil {
		t.Fatalf("second migration: %v", err)
	}

	var currentSchema string
	if err := testPool.QueryRow(context.Background(), "select current_schema()").Scan(&currentSchema); err != nil {
		t.Fatalf("current schema: %v", err)
	}
	if currentSchema != testPool.schema {
		t.Fatalf("current schema = %q, want %q", currentSchema, testPool.schema)
	}

	for _, table := range []string{"users", "user_sessions", "devices", "audit_logs"} {
		var exists bool
		err := testPool.QueryRow(context.Background(), `select to_regclass($1 || '.' || $2) is not null`, testPool.schema, table).Scan(&exists)
		if err != nil || !exists {
			t.Fatalf("table %s: exists=%v err=%v", table, exists, err)
		}
	}

	var migrationApplied bool
	if err := testPool.QueryRow(context.Background(), `select exists(select 1 from goose_db_version where version_id = 1 and is_applied)`).Scan(&migrationApplied); err != nil {
		t.Fatalf("migration version: %v", err)
	}
	if !migrationApplied {
		t.Fatal("00001_identity.sql was not applied in the test schema")
	}
}

func TestMigrateRejectsNonSHA256TokenDigest(t *testing.T) {
	testPool := openTestPool(t)
	ctx := context.Background()
	if err := Migrate(ctx, testPool.Pool); err != nil {
		t.Fatal(err)
	}

	now := time.Now().UTC()
	if _, err := testPool.Exec(ctx, `
		insert into users (id, username, username_normalized, password_hash, role, created_at, updated_at)
		values ($1, $2, $3, $4, $5, $6, $7)
	`, "user-1", "admin", "admin", "hash", "admin", now, now); err != nil {
		t.Fatalf("insert user: %v", err)
	}

	_, err := testPool.Exec(ctx, `
		insert into user_sessions (id, user_id, token_digest, purpose, created_at, expires_at)
		values ($1, $2, $3, $4, $5, $6)
	`, "session-1", "user-1", make([]byte, 31), "desktop", now, now.Add(time.Hour))
	if err == nil {
		t.Fatal("user_sessions accepted a non-32-byte token digest")
	}
}

func TestMigratePreventsAuditLogMutation(t *testing.T) {
	testPool := openTestPool(t)
	ctx := context.Background()
	if err := Migrate(ctx, testPool.Pool); err != nil {
		t.Fatal(err)
	}

	now := time.Now().UTC()
	if _, err := testPool.Exec(ctx, `
		insert into audit_logs (id, action, target_type, result, request_id, metadata, created_at)
		values ($1, $2, $3, $4, $5, '{}'::jsonb, $6)
	`, "audit-1", "auth.login_succeeded", "user", "success", "request-1", now); err != nil {
		t.Fatalf("insert audit log: %v", err)
	}

	if _, err := testPool.Exec(ctx, `update audit_logs set result = 'failure' where id = $1`, "audit-1"); err == nil {
		t.Fatal("audit_logs accepted UPDATE")
	}
	if _, err := testPool.Exec(ctx, `delete from audit_logs where id = $1`, "audit-1"); err == nil {
		t.Fatal("audit_logs accepted DELETE")
	}
}

func TestOpenDoesNotExposeDatabaseURL(t *testing.T) {
	const databaseURL = "postgres://%zz"

	pool, err := Open(context.Background(), databaseURL)
	if pool != nil {
		pool.Close()
		t.Fatal("Open() returned a pool for an invalid URL")
	}
	if err == nil {
		t.Fatal("Open() error = nil")
	}
	if strings.Contains(err.Error(), databaseURL) {
		t.Fatalf("Open() error exposed database URL: %v", err)
	}
}
