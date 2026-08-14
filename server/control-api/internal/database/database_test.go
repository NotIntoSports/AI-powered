package database

import (
	"context"
	"strings"
	"testing"
)

func TestMigrateCreatesIdentityTables(t *testing.T) {
	pool := openTestPool(t)
	if err := Migrate(context.Background(), pool); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(context.Background(), pool); err != nil {
		t.Fatalf("second migration: %v", err)
	}

	for _, table := range []string{"users", "user_sessions", "devices", "audit_logs"} {
		var exists bool
		err := pool.QueryRow(context.Background(), `select to_regclass('public.' || $1) is not null`, table).Scan(&exists)
		if err != nil || !exists {
			t.Fatalf("table %s: exists=%v err=%v", table, exists, err)
		}
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
