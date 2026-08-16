package database

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

var registerMigrationBoundaryDriver sync.Once

type migrationBoundaryDriver struct{}

func (migrationBoundaryDriver) Open(string) (driver.Conn, error) {
	return migrationBoundaryConn{}, nil
}

type migrationBoundaryConn struct{}

func (migrationBoundaryConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("prepared statements are not supported")
}

func (migrationBoundaryConn) Close() error { return nil }

func (migrationBoundaryConn) Begin() (driver.Tx, error) { return migrationBoundaryTx{}, nil }

func (migrationBoundaryConn) BeginTx(context.Context, driver.TxOptions) (driver.Tx, error) {
	return migrationBoundaryTx{}, nil
}

func (migrationBoundaryConn) ExecContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Result, error) {
	if strings.Count(query, "$$")%2 != 0 {
		return nil, errors.New("unterminated dollar-quoted string")
	}
	return driver.RowsAffected(1), nil
}

type migrationBoundaryTx struct{}

func (migrationBoundaryTx) Commit() error   { return nil }
func (migrationBoundaryTx) Rollback() error { return nil }

func TestIdentityMigrationKeepsPLpgSQLFunctionAsSingleStatement(t *testing.T) {
	registerMigrationBoundaryDriver.Do(func() {
		sql.Register("migration-boundary", migrationBoundaryDriver{})
	})
	db, err := sql.Open("migration-boundary", "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })

	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	goose.SetBaseFS(migrations)
	migrationList, err := goose.CollectMigrations("migrations", 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(migrationList) != 1 {
		t.Fatalf("migration count = %d, want 1", len(migrationList))
	}
	if err := migrationList[0].UpContext(context.Background(), db); err != nil {
		t.Fatalf("execute migration through Goose parser: %v", err)
	}
}

func TestIdentityMigrationPreservesHistoricalDeviceBindingAndDownOrder(t *testing.T) {
	versionOne, err := migrations.ReadFile("migrations/00001_identity.sql")
	if err != nil {
		t.Fatal(err)
	}
	versionTwo, err := migrations.ReadFile("migrations/00002_preserve_session_device_binding.sql")
	if err != nil {
		t.Fatal(err)
	}
	v1SQL := string(versionOne)
	if !strings.Contains(v1SQL, "device_id text references devices(id) on delete set null") {
		t.Fatal("historical migration version 1 must retain ON DELETE SET NULL")
	}
	v2SQL := string(versionTwo)
	v2DownMarker := strings.Index(v2SQL, "-- +goose Down")
	if v2DownMarker < 0 || !strings.Contains(v2SQL[:v2DownMarker], "on delete restrict") {
		t.Fatal("migration version 2 Up must establish ON DELETE RESTRICT")
	}
	if !strings.Contains(v2SQL[v2DownMarker:], "on delete set null") {
		t.Fatal("migration version 2 Down must restore ON DELETE SET NULL")
	}
	downMarker := strings.Index(v1SQL, "-- +goose Down")
	dropSessions := strings.Index(v1SQL, "drop table user_sessions;")
	dropDevices := strings.Index(v1SQL, "drop table devices;")
	if downMarker < 0 || dropSessions < downMarker || dropDevices < downMarker || dropSessions > dropDevices {
		t.Fatal("down migration must drop user_sessions before devices")
	}
}

func TestDeviceForeignKeyMigrationIsPathIndependentAtVersionOne(t *testing.T) {
	testPool := openTestPool(t)
	ctx := context.Background()
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	goose.SetBaseFS(migrations)
	db := stdlib.OpenDBFromPool(testPool.Pool)
	defer db.Close()

	if err := goose.UpToContext(ctx, db, "migrations", 1); err != nil {
		t.Fatalf("fresh up to version 1: %v", err)
	}
	assertDeviceForeignKeyDeleteAction(t, testPool, "SET NULL")

	if err := goose.UpContext(ctx, db, "migrations"); err != nil {
		t.Fatalf("full up: %v", err)
	}
	assertDeviceForeignKeyDeleteAction(t, testPool, "RESTRICT")

	if err := goose.DownToContext(ctx, db, "migrations", 1); err != nil {
		t.Fatalf("down to version 1: %v", err)
	}
	assertDeviceForeignKeyDeleteAction(t, testPool, "SET NULL")
}

func assertDeviceForeignKeyDeleteAction(t *testing.T, testPool *testPool, want string) {
	t.Helper()
	var definition string
	if err := testPool.QueryRow(context.Background(), `
		select pg_get_constraintdef(constraint_row.oid)
		from pg_constraint as constraint_row
		join pg_class as table_row on table_row.oid = constraint_row.conrelid
		join pg_namespace as schema_row on schema_row.oid = table_row.relnamespace
		where schema_row.nspname = current_schema()
		  and table_row.relname = 'user_sessions'
		  and constraint_row.conname = 'user_sessions_device_id_fkey'
	`).Scan(&definition); err != nil {
		t.Fatalf("load device foreign key: %v", err)
	}
	if !strings.Contains(definition, "ON DELETE "+want) {
		t.Fatalf("device foreign key = %q, want ON DELETE %s", definition, want)
	}
}

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

	for _, table := range []string{"users", "user_sessions", "devices", "audit_logs", "ai_provider_configs", "rtc_configs"} {
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

func TestMigrateCreatesKnowledgeTables(t *testing.T) {
	testPool := openTestPool(t)
	if err := Migrate(context.Background(), testPool.Pool); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"knowledge_chunks", "resumes"} {
		var exists bool
		err := testPool.QueryRow(context.Background(), `select to_regclass($1 || '.' || $2) is not null`, testPool.schema, table).Scan(&exists)
		if err != nil || !exists {
			t.Fatalf("table %s: exists=%v err=%v", table, exists, err)
		}
	}
	var statusDefault string
	if err := testPool.QueryRow(context.Background(), `
		select column_default
		from information_schema.columns
		where table_schema = current_schema()
		  and table_name = 'resumes'
		  and column_name = 'index_status'
	`).Scan(&statusDefault); err != nil {
		t.Fatalf("index_status default: %v", err)
	}
	if statusDefault == "" {
		t.Fatal("resumes.index_status missing default")
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

func TestIdentityMigrationDownDropsRestrictedDeviceTables(t *testing.T) {
	testPool := openTestPool(t)
	ctx := context.Background()
	if err := Migrate(ctx, testPool.Pool); err != nil {
		t.Fatal(err)
	}

	db := stdlib.OpenDBFromPool(testPool.Pool)
	defer db.Close()
	if err := goose.DownToContext(ctx, db, "migrations", 0); err != nil {
		t.Fatalf("migrate down: %v", err)
	}
	for _, table := range []string{"user_sessions", "devices", "users"} {
		var exists bool
		if err := testPool.QueryRow(ctx, `select to_regclass($1 || '.' || $2) is not null`, testPool.schema, table).Scan(&exists); err != nil {
			t.Fatalf("check table %s: %v", table, err)
		}
		if exists {
			t.Fatalf("table %s remains after down migration", table)
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
