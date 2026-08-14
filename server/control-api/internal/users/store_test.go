package users

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ai-interviewer/ai-powered/control-api/internal/database"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	userIDPattern     = regexp.MustCompile(`^[a-f0-9]{32}$`)
	userSchemaPattern = regexp.MustCompile(`^control_api_users_test_[a-f0-9]{32}$`)
)

func TestCreateNormalizesUsernameAndKeepsPasswordPrivate(t *testing.T) {
	pool := openUserTestPool(t)
	store := NewStore(pool)
	ctx := context.Background()

	user, err := store.Create(ctx, CreateInput{
		Username:     "  Admin  ",
		PasswordHash: "encoded-password-hash",
		Role:         RoleAdmin,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !userIDPattern.MatchString(user.ID) {
		t.Fatalf("ID = %q, want 32 lowercase hexadecimal characters", user.ID)
	}
	if user.Username != "Admin" {
		t.Fatalf("Username = %q, want Admin", user.Username)
	}
	if _, exposed := reflect.TypeOf(user).FieldByName("PasswordHash"); exposed {
		t.Fatal("User exposes PasswordHash")
	}

	loaded, err := store.GetByNormalizedUsername(ctx, "admin")
	if err != nil {
		t.Fatal(err)
	}
	if loaded.User != user {
		t.Fatalf("loaded user = %#v, want %#v", loaded.User, user)
	}
	if loaded.PasswordHash != "encoded-password-hash" {
		t.Fatalf("PasswordHash = %q", loaded.PasswordHash)
	}

	var normalized string
	if err := pool.QueryRow(ctx, `select username_normalized from users where id = $1`, user.ID).Scan(&normalized); err != nil {
		t.Fatal(err)
	}
	if normalized != "admin" {
		t.Fatalf("username_normalized = %q, want admin", normalized)
	}

	_, err = store.Create(ctx, CreateInput{
		Username:     "ADMIN",
		PasswordHash: "different-hash",
		Role:         RoleOperator,
	})
	if !errors.Is(err, ErrUsernameTaken) {
		t.Fatalf("duplicate error = %v, want ErrUsernameTaken", err)
	}
}

func TestCreateAcceptsUnicodeLettersAndRejectsInvalidUsernames(t *testing.T) {
	pool := openUserTestPool(t)
	store := NewStore(pool)
	ctx := context.Background()

	created, err := store.Create(ctx, CreateInput{
		Username:     "  用户.Name_1  ",
		PasswordHash: "encoded-password-hash",
		Role:         RoleOperator,
	})
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := store.GetByNormalizedUsername(ctx, "用户.name_1")
	if err != nil || loaded.ID != created.ID {
		t.Fatalf("loaded=%#v err=%v", loaded, err)
	}

	for _, username := range []string{"ab", "has space", "bad/slash"} {
		_, err := store.Create(ctx, CreateInput{
			Username:     username,
			PasswordHash: "encoded-password-hash",
			Role:         RoleOperator,
		})
		if !errors.Is(err, ErrInvalidUsername) {
			t.Fatalf("username %q error = %v, want ErrInvalidUsername", username, err)
		}
	}
}

func TestSetStatusTransitionsAndSoftDeletes(t *testing.T) {
	pool := openUserTestPool(t)
	store := NewStore(pool)
	ctx := context.Background()

	user, err := store.Create(ctx, CreateInput{
		Username:     "operator",
		PasswordHash: "encoded-password-hash",
		Role:         RoleOperator,
	})
	if err != nil {
		t.Fatal(err)
	}

	for _, status := range []Status{StatusDisabled, StatusActive, StatusDeleted} {
		if err := store.SetStatus(ctx, user.ID, status); err != nil {
			t.Fatalf("SetStatus(%q): %v", status, err)
		}
	}

	var rowCount int
	var status Status
	if err := pool.QueryRow(ctx, `select count(*), min(status::text) from users where id = $1`, user.ID).Scan(&rowCount, &status); err != nil {
		t.Fatal(err)
	}
	if rowCount != 1 || status != StatusDeleted {
		t.Fatalf("rowCount=%d status=%q", rowCount, status)
	}

	listed, err := store.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 1 || listed[0].Status != StatusDeleted {
		t.Fatalf("List() = %#v", listed)
	}
}

func TestSetStatusProtectsLastActiveAdmin(t *testing.T) {
	pool := openUserTestPool(t)
	store := NewStore(pool)
	ctx := context.Background()

	first := createTestUser(t, store, "first-admin", RoleAdmin)
	if err := store.SetStatus(ctx, first.ID, StatusDisabled); !errors.Is(err, ErrLastAdmin) {
		t.Fatalf("disable only admin error = %v, want ErrLastAdmin", err)
	}

	second := createTestUser(t, store, "second-admin", RoleAdmin)
	if err := store.SetStatus(ctx, first.ID, StatusDisabled); err != nil {
		t.Fatal(err)
	}
	if err := store.SetStatus(ctx, second.ID, StatusDeleted); !errors.Is(err, ErrLastAdmin) {
		t.Fatalf("delete last active admin error = %v, want ErrLastAdmin", err)
	}
}

func TestSetStatusStartsTransactionAndAcquiresAdvisoryLock(t *testing.T) {
	db := &advisoryUserDB{tx: &advisoryUserTx{}}
	if err := NewStore(db).SetStatus(context.Background(), "operator-id", StatusDisabled); err != nil {
		t.Fatal(err)
	}
	if db.beginCalls != 1 {
		t.Fatalf("Begin calls = %d, want 1", db.beginCalls)
	}
	if len(db.tx.statements) == 0 || !strings.Contains(db.tx.statements[0], "pg_advisory_xact_lock") {
		t.Fatalf("first transaction statement = %q, want advisory lock", firstStatement(db.tx.statements))
	}
}

func TestConcurrentAdminStatusTransitionsPreserveOneActiveAdmin(t *testing.T) {
	pool := openUserTestPool(t)
	store := NewStore(pool)
	first := createTestUser(t, store, "concurrent-admin-one", RoleAdmin)
	second := createTestUser(t, store, "concurrent-admin-two", RoleAdmin)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	start := make(chan struct{})
	results := make(chan error, 2)
	var ready sync.WaitGroup
	ready.Add(2)
	for _, id := range []string{first.ID, second.ID} {
		go func(userID string) {
			ready.Done()
			<-start
			results <- store.SetStatus(ctx, userID, StatusDisabled)
		}(id)
	}
	ready.Wait()
	close(start)

	var succeeded, lastAdmin int
	for range 2 {
		select {
		case err := <-results:
			switch {
			case err == nil:
				succeeded++
			case errors.Is(err, ErrLastAdmin):
				lastAdmin++
			default:
				t.Fatalf("concurrent SetStatus error = %v", err)
			}
		case <-ctx.Done():
			t.Fatalf("concurrent SetStatus timed out: %v", ctx.Err())
		}
	}
	if succeeded != 1 || lastAdmin != 1 {
		t.Fatalf("succeeded=%d lastAdmin=%d, want 1 and 1", succeeded, lastAdmin)
	}
	var activeAdmins int
	if err := pool.QueryRow(context.Background(), `select count(*) from users where role = 'admin' and status = 'active'`).Scan(&activeAdmins); err != nil {
		t.Fatal(err)
	}
	if activeAdmins != 1 {
		t.Fatalf("active admins = %d, want 1", activeAdmins)
	}
}

func TestReplacePasswordAndMissingUserReturnStableErrors(t *testing.T) {
	pool := openUserTestPool(t)
	store := NewStore(pool)
	ctx := context.Background()
	user := createTestUser(t, store, "password-user", RoleOperator)

	if err := store.ReplacePassword(ctx, user.ID, "replacement-hash"); err != nil {
		t.Fatal(err)
	}
	loaded, err := store.GetByNormalizedUsername(ctx, "password-user")
	if err != nil || loaded.PasswordHash != "replacement-hash" {
		t.Fatalf("loaded=%#v err=%v", loaded, err)
	}

	if err := store.ReplacePassword(ctx, "missing", "replacement-hash"); !errors.Is(err, ErrUserNotFound) {
		t.Fatalf("ReplacePassword missing error = %v", err)
	}
	if err := store.SetStatus(ctx, "missing", StatusDisabled); !errors.Is(err, ErrUserNotFound) {
		t.Fatalf("SetStatus missing error = %v", err)
	}
	if _, err := store.GetByNormalizedUsername(ctx, "missing"); !errors.Is(err, ErrUserNotFound) {
		t.Fatalf("GetByNormalizedUsername missing error = %v", err)
	}
}

func TestCreateTranslatesDatabaseFailureToStableError(t *testing.T) {
	store := NewStore(failingUserDB{err: errors.New("SQLSTATE 99999 from users query")})
	_, err := store.Create(context.Background(), CreateInput{
		Username:     "stable-error-user",
		PasswordHash: "encoded-password-hash",
		Role:         RoleOperator,
	})
	if !errors.Is(err, ErrStore) {
		t.Fatalf("error = %v, want ErrStore", err)
	}
	if strings.Contains(err.Error(), "SQLSTATE") {
		t.Fatalf("database details leaked: %v", err)
	}
}

type failingUserDB struct {
	err error
}

func (db failingUserDB) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, db.err
}

func (db failingUserDB) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, db.err
}

func (db failingUserDB) QueryRow(context.Context, string, ...any) pgx.Row {
	return failingUserRow{err: db.err}
}

func (db failingUserDB) Begin(context.Context) (pgx.Tx, error) {
	return nil, db.err
}

type failingUserRow struct {
	err error
}

func (row failingUserRow) Scan(...any) error {
	return row.err
}

type advisoryUserDB struct {
	tx         *advisoryUserTx
	beginCalls int
}

func (db *advisoryUserDB) Begin(context.Context) (pgx.Tx, error) {
	db.beginCalls++
	return db.tx, nil
}

func (*advisoryUserDB) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, errors.New("query executed outside transaction")
}

func (*advisoryUserDB) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, errors.New("query executed outside transaction")
}

func (*advisoryUserDB) QueryRow(context.Context, string, ...any) pgx.Row {
	return failingUserRow{err: errors.New("query executed outside transaction")}
}

type advisoryUserTx struct {
	statements []string
}

func (tx *advisoryUserTx) Begin(context.Context) (pgx.Tx, error) { return tx, nil }
func (*advisoryUserTx) Commit(context.Context) error             { return nil }
func (*advisoryUserTx) Rollback(context.Context) error           { return nil }
func (*advisoryUserTx) CopyFrom(context.Context, pgx.Identifier, []string, pgx.CopyFromSource) (int64, error) {
	return 0, errors.New("unexpected CopyFrom")
}
func (*advisoryUserTx) SendBatch(context.Context, *pgx.Batch) pgx.BatchResults { return nil }
func (*advisoryUserTx) LargeObjects() pgx.LargeObjects                         { return pgx.LargeObjects{} }
func (*advisoryUserTx) Prepare(context.Context, string, string) (*pgconn.StatementDescription, error) {
	return nil, errors.New("unexpected Prepare")
}
func (tx *advisoryUserTx) Exec(_ context.Context, sql string, _ ...any) (pgconn.CommandTag, error) {
	tx.statements = append(tx.statements, sql)
	return pgconn.NewCommandTag("UPDATE 1"), nil
}
func (*advisoryUserTx) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, errors.New("unexpected Query")
}
func (tx *advisoryUserTx) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	tx.statements = append(tx.statements, sql)
	return userStatusRow{role: RoleOperator, status: StatusActive}
}
func (*advisoryUserTx) Conn() *pgx.Conn { return nil }

type userStatusRow struct {
	role   Role
	status Status
}

func (row userStatusRow) Scan(dest ...any) error {
	if len(dest) != 2 {
		return errors.New("unexpected scan")
	}
	*(dest[0].(*Role)) = row.role
	*(dest[1].(*Status)) = row.status
	return nil
}

func firstStatement(statements []string) string {
	if len(statements) == 0 {
		return ""
	}
	return statements[0]
}

func createTestUser(t *testing.T, store *Store, username string, role Role) User {
	t.Helper()
	user, err := store.Create(context.Background(), CreateInput{
		Username:     username,
		PasswordHash: "encoded-password-hash",
		Role:         role,
	})
	if err != nil {
		t.Fatal(err)
	}
	return user
}

func openUserTestPool(t *testing.T) *pgxpool.Pool {
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

	schema := newUserTestSchemaName(t)
	quotedSchema := quoteUserTestSchema(t, schema)
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

func newUserTestSchemaName(t *testing.T) string {
	t.Helper()
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		t.Fatalf("generate test schema name: %v", err)
	}
	return "control_api_users_test_" + hex.EncodeToString(random)
}

func quoteUserTestSchema(t *testing.T, schema string) string {
	t.Helper()
	if !userSchemaPattern.MatchString(schema) {
		t.Fatalf("unsafe test schema name %q", schema)
	}
	return fmt.Sprintf(`"%s"`, schema)
}
