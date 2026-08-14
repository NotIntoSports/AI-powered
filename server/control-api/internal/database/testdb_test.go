package database

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"regexp"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

var testSchemaName = regexp.MustCompile(`^control_api_test_[a-f0-9]{32}$`)

type testPool struct {
	*pgxpool.Pool
	schema string
}

func openTestPool(t *testing.T) *testPool {
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

	schema := newTestSchemaName(t)
	quotedSchema := quoteTestSchema(t, schema)
	if _, err := adminPool.Exec(ctx, "create schema "+quotedSchema); err != nil {
		t.Fatalf("create test schema: %v", err)
	}
	t.Cleanup(func() {
		cleanupContext, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := adminPool.Exec(cleanupContext, "drop schema "+quotedSchema+" cascade"); err != nil {
			t.Errorf("drop test schema %q: %v", schema, err)
		}
	})

	poolConfig, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatalf("parse test PostgreSQL pool configuration: %v", err)
	}
	if poolConfig.ConnConfig.RuntimeParams == nil {
		poolConfig.ConnConfig.RuntimeParams = make(map[string]string)
	}
	poolConfig.ConnConfig.RuntimeParams["search_path"] = schema

	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatalf("open schema-scoped test PostgreSQL pool: %v", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Fatalf("ping schema-scoped test PostgreSQL pool: %v", err)
	}
	t.Cleanup(pool.Close)
	return &testPool{Pool: pool, schema: schema}
}

func newTestSchemaName(t *testing.T) string {
	t.Helper()

	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		t.Fatalf("generate test schema name: %v", err)
	}
	return "control_api_test_" + hex.EncodeToString(bytes)
}

func quoteTestSchema(t *testing.T, schema string) string {
	t.Helper()
	if !testSchemaName.MatchString(schema) {
		t.Fatalf("unsafe test schema name %q", schema)
	}
	return fmt.Sprintf("\"%s\"", schema)
}
