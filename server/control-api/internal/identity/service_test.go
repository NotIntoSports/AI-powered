package identity

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/ai-interviewer/ai-powered/control-api/internal/audit"
	"github.com/ai-interviewer/ai-powered/control-api/internal/password"
	"github.com/ai-interviewer/ai-powered/control-api/internal/users"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const testPassword = "correct horse battery staple"

func TestCreateInitialAdminCreatesOnlyOneAdministratorAndAudits(t *testing.T) {
	db := newMemoryDB()
	service := NewService(db)

	created, err := service.CreateInitialAdmin(context.Background(), "  Owner  ", testPassword)
	if err != nil {
		t.Fatal(err)
	}
	if created.Username != "Owner" || created.Role != users.RoleAdmin || created.Status != users.StatusActive {
		t.Fatalf("created = %#v", created)
	}
	if db.beginCalls != 1 || db.commitCalls != 1 || db.rollbackCalls != 0 {
		t.Fatalf("begin=%d commit=%d rollback=%d", db.beginCalls, db.commitCalls, db.rollbackCalls)
	}
	if len(db.users) != 1 {
		t.Fatalf("users = %d, want one", len(db.users))
	}
	for _, stored := range db.users {
		if stored.role != users.RoleAdmin {
			t.Fatalf("bootstrap seeded role %q, want admin", stored.role)
		}
		match, _, verifyErr := password.Verify(stored.passwordHash, testPassword)
		if verifyErr != nil || !match {
			t.Fatalf("stored password hash did not verify: match=%v err=%v", match, verifyErr)
		}
	}
	if len(db.audits) != 1 || db.audits[0].action != audit.ActionAdminCreated || db.audits[0].targetID != created.ID {
		t.Fatalf("audits = %#v", db.audits)
	}
	if len(db.traces) == 0 || !strings.Contains(db.traces[0], "pg_advisory_xact_lock") {
		t.Fatalf("first transaction statement = %q, want bootstrap advisory lock", firstTrace(db.traces))
	}

	_, err = service.CreateInitialAdmin(context.Background(), "second-owner", testPassword)
	if !errors.Is(err, ErrAdminAlreadyExists) {
		t.Fatalf("second bootstrap error = %v, want ErrAdminAlreadyExists", err)
	}
	if len(db.users) != 1 || len(db.audits) != 1 {
		t.Fatalf("second bootstrap mutated state: users=%d audits=%d", len(db.users), len(db.audits))
	}
	if db.beginCalls != 2 || db.commitCalls != 1 || db.rollbackCalls != 1 {
		t.Fatalf("after rejection begin=%d commit=%d rollback=%d", db.beginCalls, db.commitCalls, db.rollbackCalls)
	}
}

func TestCreateOperatorRequiresActiveAdministratorAndAudits(t *testing.T) {
	for _, actor := range []users.User{
		{ID: "operator-actor", Role: users.RoleOperator, Status: users.StatusActive},
		{ID: "disabled-admin", Role: users.RoleAdmin, Status: users.StatusDisabled},
	} {
		db := newMemoryDB()
		_, err := NewService(db).CreateOperator(context.Background(), actor, "client-user", testPassword)
		if !errors.Is(err, ErrForbidden) {
			t.Fatalf("actor %#v error = %v, want ErrForbidden", actor, err)
		}
		if db.beginCalls != 0 {
			t.Fatalf("unauthorized actor began %d transactions", db.beginCalls)
		}
	}

	db := newMemoryDB()
	admin := users.User{ID: "admin-actor", Username: "owner", Role: users.RoleAdmin, Status: users.StatusActive}
	created, err := NewService(db).CreateOperator(context.Background(), admin, "client-user", testPassword)
	if err != nil {
		t.Fatal(err)
	}
	if created.Role != users.RoleOperator {
		t.Fatalf("role = %q, want operator", created.Role)
	}
	if len(db.audits) != 1 || db.audits[0].action != audit.ActionUserCreated || db.audits[0].actorUserID != admin.ID {
		t.Fatalf("audits = %#v", db.audits)
	}
}

func TestResetPasswordRequiresActiveAdministratorRevokesSessionsAndAudits(t *testing.T) {
	for _, actor := range []users.User{
		{ID: "operator-actor", Role: users.RoleOperator, Status: users.StatusActive},
		{ID: "deleted-admin", Role: users.RoleAdmin, Status: users.StatusDeleted},
	} {
		db := newMemoryDB()
		err := NewService(db).ResetPassword(context.Background(), actor, "target", testPassword)
		if !errors.Is(err, ErrForbidden) {
			t.Fatalf("actor %#v error = %v, want ErrForbidden", actor, err)
		}
		if db.beginCalls != 0 {
			t.Fatalf("unauthorized actor began %d transactions", db.beginCalls)
		}
	}

	db := newMemoryDB()
	db.users["target"] = memoryUser{id: "target", username: "client-user", normalized: "client-user", passwordHash: "old-hash", role: users.RoleOperator, status: users.StatusActive}
	db.sessions["session-one"] = memorySession{userID: "target"}
	db.sessions["session-two"] = memorySession{userID: "target"}
	admin := users.User{ID: "admin-actor", Username: "owner", Role: users.RoleAdmin, Status: users.StatusActive}

	if err := NewService(db).ResetPassword(context.Background(), admin, "target", "replacement password value"); err != nil {
		t.Fatal(err)
	}
	match, _, err := password.Verify(db.users["target"].passwordHash, "replacement password value")
	if err != nil || !match {
		t.Fatalf("replacement hash match=%v err=%v", match, err)
	}
	for id, session := range db.sessions {
		if !session.revoked {
			t.Fatalf("session %q was not revoked", id)
		}
	}
	if len(db.audits) != 1 || db.audits[0].action != audit.ActionUserPasswordReset || db.audits[0].actorUserID != admin.ID || db.audits[0].targetID != "target" {
		t.Fatalf("audits = %#v", db.audits)
	}
	if db.beginCalls != 1 || db.commitCalls != 1 || db.rollbackCalls != 0 {
		t.Fatalf("begin=%d commit=%d rollback=%d", db.beginCalls, db.commitCalls, db.rollbackCalls)
	}
}

func TestAuditFailureRollsBackIdentityMutationAndSessionRevocation(t *testing.T) {
	db := newMemoryDB()
	db.users["target"] = memoryUser{id: "target", username: "client-user", normalized: "client-user", passwordHash: "old-hash", role: users.RoleOperator, status: users.StatusActive}
	db.sessions["session-one"] = memorySession{userID: "target"}
	db.failAudit = true
	admin := users.User{ID: "admin-actor", Role: users.RoleAdmin, Status: users.StatusActive}

	err := NewService(db).ResetPassword(context.Background(), admin, "target", "replacement password value")
	if !errors.Is(err, ErrService) {
		t.Fatalf("error = %v, want ErrService", err)
	}
	if db.users["target"].passwordHash != "old-hash" || db.sessions["session-one"].revoked {
		t.Fatalf("failed audit did not roll back state: user=%#v session=%#v", db.users["target"], db.sessions["session-one"])
	}
	if db.commitCalls != 0 || db.rollbackCalls != 1 || len(db.audits) != 0 {
		t.Fatalf("commit=%d rollback=%d audits=%d", db.commitCalls, db.rollbackCalls, len(db.audits))
	}
}

type memoryUser struct {
	id           string
	username     string
	normalized   string
	passwordHash string
	role         users.Role
	status       users.Status
	createdAt    time.Time
	updatedAt    time.Time
}

type memorySession struct {
	userID  string
	revoked bool
}

type memoryAudit struct {
	actorUserID string
	action      audit.Action
	targetID    string
}

type memoryDB struct {
	users         map[string]memoryUser
	sessions      map[string]memorySession
	audits        []memoryAudit
	traces        []string
	failAudit     bool
	beginCalls    int
	commitCalls   int
	rollbackCalls int
}

func newMemoryDB() *memoryDB {
	return &memoryDB{users: map[string]memoryUser{}, sessions: map[string]memorySession{}}
}

func (db *memoryDB) Begin(context.Context) (pgx.Tx, error) {
	db.beginCalls++
	return &memoryTx{
		parent:   db,
		users:    cloneUsers(db.users),
		sessions: cloneSessions(db.sessions),
		audits:   append([]memoryAudit(nil), db.audits...),
	}, nil
}

func (*memoryDB) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, errors.New("query executed outside transaction")
}

func (*memoryDB) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, errors.New("query executed outside transaction")
}

func (*memoryDB) QueryRow(context.Context, string, ...any) pgx.Row {
	return memoryRow{err: errors.New("query executed outside transaction")}
}

type memoryTx struct {
	parent   *memoryDB
	users    map[string]memoryUser
	sessions map[string]memorySession
	audits   []memoryAudit
	closed   bool
}

func (tx *memoryTx) Begin(context.Context) (pgx.Tx, error) {
	return nil, errors.New("unexpected nested transaction")
}

func (tx *memoryTx) Commit(context.Context) error {
	if tx.closed {
		return pgx.ErrTxClosed
	}
	tx.closed = true
	tx.parent.users = tx.users
	tx.parent.sessions = tx.sessions
	tx.parent.audits = tx.audits
	tx.parent.commitCalls++
	return nil
}

func (tx *memoryTx) Rollback(context.Context) error {
	if tx.closed {
		return pgx.ErrTxClosed
	}
	tx.closed = true
	tx.parent.rollbackCalls++
	return nil
}

func (*memoryTx) CopyFrom(context.Context, pgx.Identifier, []string, pgx.CopyFromSource) (int64, error) {
	return 0, errors.New("unexpected CopyFrom")
}

func (*memoryTx) SendBatch(context.Context, *pgx.Batch) pgx.BatchResults { return nil }
func (*memoryTx) LargeObjects() pgx.LargeObjects                         { return pgx.LargeObjects{} }

func (*memoryTx) Prepare(context.Context, string, string) (*pgconn.StatementDescription, error) {
	return nil, errors.New("unexpected Prepare")
}

func (tx *memoryTx) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	tx.parent.traces = append(tx.parent.traces, sql)
	switch {
	case strings.Contains(sql, "pg_advisory_xact_lock"):
		return pgconn.NewCommandTag("SELECT 1"), nil
	case strings.Contains(sql, "update users") && strings.Contains(sql, "password_hash"):
		id := args[0].(string)
		user, ok := tx.users[id]
		if !ok {
			return pgconn.NewCommandTag("UPDATE 0"), nil
		}
		user.passwordHash = args[1].(string)
		tx.users[id] = user
		return pgconn.NewCommandTag("UPDATE 1"), nil
	case strings.Contains(sql, "update user_sessions"):
		userID := args[0].(string)
		var affected int
		for id, session := range tx.sessions {
			if session.userID == userID && !session.revoked {
				session.revoked = true
				tx.sessions[id] = session
				affected++
			}
		}
		return pgconn.NewCommandTag("UPDATE " + string(rune('0'+affected))), nil
	case strings.Contains(sql, "insert into audit_logs"):
		if tx.parent.failAudit {
			return pgconn.CommandTag{}, errors.New("forced audit failure")
		}
		tx.audits = append(tx.audits, memoryAudit{
			actorUserID: stringArg(args[1]),
			action:      args[2].(audit.Action),
			targetID:    stringArg(args[4]),
		})
		return pgconn.NewCommandTag("INSERT 0 1"), nil
	default:
		return pgconn.CommandTag{}, errors.New("unexpected Exec: " + sql)
	}
}

func (*memoryTx) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, errors.New("unexpected Query")
}

func (tx *memoryTx) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	tx.parent.traces = append(tx.parent.traces, sql)
	switch {
	case strings.Contains(sql, "count(*)") && strings.Contains(sql, "role = 'admin'"):
		count := 0
		for _, user := range tx.users {
			if user.role == users.RoleAdmin && user.status != users.StatusDeleted {
				count++
			}
		}
		return memoryRow{values: []any{count}}
	case strings.Contains(sql, "insert into users"):
		id := args[0].(string)
		createdAt := args[6].(time.Time)
		stored := memoryUser{
			id:           id,
			username:     args[1].(string),
			normalized:   args[2].(string),
			passwordHash: args[3].(string),
			role:         args[4].(users.Role),
			status:       args[5].(users.Status),
			createdAt:    createdAt,
			updatedAt:    createdAt,
		}
		for _, user := range tx.users {
			if user.normalized == stored.normalized {
				return memoryRow{err: &pgconn.PgError{Code: "23505", ConstraintName: "users_username_normalized_key"}}
			}
		}
		tx.users[id] = stored
		return memoryRow{values: []any{id, stored.username, stored.role, stored.status, stored.createdAt, stored.updatedAt, (*time.Time)(nil)}}
	default:
		return memoryRow{err: errors.New("unexpected QueryRow: " + sql)}
	}
}

func (*memoryTx) Conn() *pgx.Conn { return nil }

type memoryRow struct {
	values []any
	err    error
}

func (row memoryRow) Scan(dest ...any) error {
	if row.err != nil {
		return row.err
	}
	if len(dest) != len(row.values) {
		return errors.New("unexpected scan destination count")
	}
	for index, value := range row.values {
		switch target := dest[index].(type) {
		case *int:
			*target = value.(int)
		case *string:
			*target = value.(string)
		case *users.Role:
			*target = value.(users.Role)
		case *users.Status:
			*target = value.(users.Status)
		case *time.Time:
			*target = value.(time.Time)
		case **time.Time:
			*target = value.(*time.Time)
		default:
			return errors.New("unexpected scan destination type")
		}
	}
	return nil
}

func cloneUsers(source map[string]memoryUser) map[string]memoryUser {
	result := make(map[string]memoryUser, len(source))
	for id, user := range source {
		result[id] = user
	}
	return result
}

func cloneSessions(source map[string]memorySession) map[string]memorySession {
	result := make(map[string]memorySession, len(source))
	for id, session := range source {
		result[id] = session
	}
	return result
}

func stringArg(value any) string {
	if value == nil {
		return ""
	}
	return value.(string)
}

func firstTrace(traces []string) string {
	if len(traces) == 0 {
		return ""
	}
	return traces[0]
}
