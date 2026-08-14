package identity

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ai-interviewer/ai-powered/control-api/internal/audit"
	"github.com/ai-interviewer/ai-powered/control-api/internal/database"
	"github.com/ai-interviewer/ai-powered/control-api/internal/password"
	"github.com/ai-interviewer/ai-powered/control-api/internal/users"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
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
		if db.beginCalls != 1 || db.rollbackCalls != 1 {
			t.Fatalf("unauthorized actor transaction begin=%d rollback=%d", db.beginCalls, db.rollbackCalls)
		}
	}

	db := newMemoryDB()
	admin := users.User{ID: "admin-actor", Username: "owner", Role: users.RoleAdmin, Status: users.StatusActive}
	seedMemoryUser(db, admin)
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

func TestCreateUserAllowsAdministratorRole(t *testing.T) {
	db := newMemoryDB()
	admin := users.User{ID: "admin-actor", Username: "owner", Role: users.RoleAdmin, Status: users.StatusActive}
	seedMemoryUser(db, admin)
	created, err := NewService(db).CreateUser(context.Background(), admin, "second-admin", testPassword, users.RoleAdmin)
	if err != nil {
		t.Fatal(err)
	}
	if created.Role != users.RoleAdmin {
		t.Fatalf("role = %q, want admin", created.Role)
	}
	if len(db.audits) != 1 || db.audits[0].action != audit.ActionUserCreated || db.audits[0].actorUserID != admin.ID {
		t.Fatalf("audits = %#v", db.audits)
	}
}

func TestCreateUserHashesPasswordBeforeOpeningTransaction(t *testing.T) {
	db := newMemoryDB()
	admin := users.User{ID: "admin-actor", Username: "owner", Role: users.RoleAdmin, Status: users.StatusActive}
	seedMemoryUser(db, admin)

	_, err := NewService(db).CreateUser(context.Background(), admin, "second-admin", "short", users.RoleAdmin)
	if !errors.Is(err, password.ErrInvalidPassword) {
		t.Fatalf("error = %v, want ErrInvalidPassword", err)
	}
	if db.beginCalls != 0 {
		t.Fatalf("password hash opened a transaction: begin=%d", db.beginCalls)
	}
}

func TestSetUserStatusDisablesAndRevokesSessions(t *testing.T) {
	db := newMemoryDB()
	admin := users.User{ID: "admin-actor", Username: "owner", Role: users.RoleAdmin, Status: users.StatusActive}
	operator := users.User{ID: "operator-1", Username: "client", Role: users.RoleOperator, Status: users.StatusActive}
	seedMemoryUser(db, admin)
	seedMemoryUser(db, operator)
	db.sessions["session-1"] = memorySession{userID: operator.ID}
	db.sessions["session-2"] = memorySession{userID: operator.ID}

	if err := NewService(db).SetUserStatus(context.Background(), admin, operator.ID, users.StatusDisabled); err != nil {
		t.Fatal(err)
	}
	if db.users[operator.ID].status != users.StatusDisabled {
		t.Fatalf("status = %s", db.users[operator.ID].status)
	}
	for id, session := range db.sessions {
		if session.userID == operator.ID && !session.revoked {
			t.Fatalf("session %s still active", id)
		}
	}
	if len(db.audits) != 1 || db.audits[0].action != audit.ActionUserStatusChanged {
		t.Fatalf("audits = %#v", db.audits)
	}
}

func TestSetUserStatusProtectsLastActiveAdmin(t *testing.T) {
	db := newMemoryDB()
	admin := users.User{ID: "admin-actor", Username: "owner", Role: users.RoleAdmin, Status: users.StatusActive}
	seedMemoryUser(db, admin)
	err := NewService(db).SetUserStatus(context.Background(), admin, admin.ID, users.StatusDisabled)
	if !errors.Is(err, users.ErrLastAdmin) {
		t.Fatalf("error = %v, want ErrLastAdmin", err)
	}
	if db.users[admin.ID].status != users.StatusActive {
		t.Fatal("last admin was disabled")
	}
}

func TestRevokeUserSessionsCanPreserveCurrent(t *testing.T) {
	db := newMemoryDB()
	admin := users.User{ID: "admin-actor", Username: "owner", Role: users.RoleAdmin, Status: users.StatusActive}
	seedMemoryUser(db, admin)
	db.sessions["keep"] = memorySession{userID: admin.ID}
	db.sessions["drop"] = memorySession{userID: admin.ID}

	if err := NewService(db).RevokeUserSessions(context.Background(), admin, admin.ID, "keep"); err != nil {
		t.Fatal(err)
	}
	if db.sessions["keep"].revoked {
		t.Fatal("current session was revoked")
	}
	if !db.sessions["drop"].revoked {
		t.Fatal("other session was not revoked")
	}
	if len(db.audits) != 1 || db.audits[0].action != audit.ActionUserSessionsRevoked || db.audits[0].actorUserID != admin.ID || db.audits[0].targetID != admin.ID {
		t.Fatalf("audits = %#v", db.audits)
	}
}

func TestCreateOperatorReloadsAndLocksPersistedActor(t *testing.T) {
	for name, persisted := range map[string]*users.User{
		"operator": {ID: "actor", Username: "operator", Role: users.RoleOperator, Status: users.StatusActive},
		"disabled": {ID: "actor", Username: "disabled", Role: users.RoleAdmin, Status: users.StatusDisabled},
		"deleted":  {ID: "actor", Username: "deleted", Role: users.RoleAdmin, Status: users.StatusDeleted},
		"missing":  nil,
	} {
		t.Run(name, func(t *testing.T) {
			db := newMemoryDB()
			if persisted != nil {
				seedMemoryUser(db, *persisted)
			}
			forged := users.User{ID: "actor", Username: "forged", Role: users.RoleAdmin, Status: users.StatusActive}

			_, err := NewService(db).CreateOperator(context.Background(), forged, "must-not-exist", testPassword)
			if !errors.Is(err, ErrForbidden) {
				t.Fatalf("error = %v, want ErrForbidden", err)
			}
			if _, exists := findMemoryUserByUsername(db, "must-not-exist"); exists || len(db.audits) != 0 {
				t.Fatalf("unauthorized create mutated state: users=%#v audits=%#v", db.users, db.audits)
			}
		})
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
		if db.beginCalls != 1 || db.rollbackCalls != 1 {
			t.Fatalf("unauthorized actor transaction begin=%d rollback=%d", db.beginCalls, db.rollbackCalls)
		}
	}

	db := newMemoryDB()
	db.users["target"] = memoryUser{id: "target", username: "client-user", normalized: "client-user", passwordHash: "old-hash", role: users.RoleOperator, status: users.StatusActive}
	db.sessions["session-one"] = memorySession{userID: "target"}
	db.sessions["session-two"] = memorySession{userID: "target"}
	admin := users.User{ID: "admin-actor", Username: "owner", Role: users.RoleAdmin, Status: users.StatusActive}
	seedMemoryUser(db, admin)

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

func TestResetPasswordReloadsAndLocksPersistedActor(t *testing.T) {
	for name, persisted := range map[string]*users.User{
		"operator": {ID: "actor", Username: "operator", Role: users.RoleOperator, Status: users.StatusActive},
		"disabled": {ID: "actor", Username: "disabled", Role: users.RoleAdmin, Status: users.StatusDisabled},
		"deleted":  {ID: "actor", Username: "deleted", Role: users.RoleAdmin, Status: users.StatusDeleted},
		"missing":  nil,
	} {
		t.Run(name, func(t *testing.T) {
			db := newMemoryDB()
			if persisted != nil {
				seedMemoryUser(db, *persisted)
			}
			db.users["target"] = memoryUser{id: "target", username: "target-user", normalized: "target-user", passwordHash: "old-hash", role: users.RoleOperator, status: users.StatusActive}
			db.sessions["session"] = memorySession{userID: "target"}
			forged := users.User{ID: "actor", Username: "forged", Role: users.RoleAdmin, Status: users.StatusActive}

			err := NewService(db).ResetPassword(context.Background(), forged, "target", "replacement password value")
			if !errors.Is(err, ErrForbidden) {
				t.Fatalf("error = %v, want ErrForbidden", err)
			}
			if db.users["target"].passwordHash != "old-hash" || db.sessions["session"].revoked || len(db.audits) != 0 {
				t.Fatalf("unauthorized reset mutated state: user=%#v session=%#v audits=%#v", db.users["target"], db.sessions["session"], db.audits)
			}
		})
	}
}

func TestAuditFailureRollsBackIdentityMutationAndSessionRevocation(t *testing.T) {
	db := newMemoryDB()
	db.users["target"] = memoryUser{id: "target", username: "client-user", normalized: "client-user", passwordHash: "old-hash", role: users.RoleOperator, status: users.StatusActive}
	db.sessions["session-one"] = memorySession{userID: "target"}
	db.failAudit = true
	admin := users.User{ID: "admin-actor", Role: users.RoleAdmin, Status: users.StatusActive}
	seedMemoryUser(db, admin)

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

func TestCreateAuditFailuresRollBackInsertedUsers(t *testing.T) {
	t.Run("initial administrator", func(t *testing.T) {
		db := newMemoryDB()
		db.failAudit = true

		_, err := NewService(db).CreateInitialAdmin(context.Background(), "owner", testPassword)
		if !errors.Is(err, ErrService) {
			t.Fatalf("error = %v, want ErrService", err)
		}
		if len(db.users) != 0 || len(db.audits) != 0 || db.commitCalls != 0 || db.rollbackCalls != 1 {
			t.Fatalf("users=%#v audits=%#v commit=%d rollback=%d", db.users, db.audits, db.commitCalls, db.rollbackCalls)
		}
	})

	t.Run("operator", func(t *testing.T) {
		db := newMemoryDB()
		admin := users.User{ID: "admin-actor", Username: "owner", Role: users.RoleAdmin, Status: users.StatusActive}
		seedMemoryUser(db, admin)
		db.failAudit = true

		_, err := NewService(db).CreateOperator(context.Background(), admin, "client-user", testPassword)
		if !errors.Is(err, ErrService) {
			t.Fatalf("error = %v, want ErrService", err)
		}
		if _, exists := findMemoryUserByUsername(db, "client-user"); exists || len(db.audits) != 0 || db.commitCalls != 0 || db.rollbackCalls != 1 {
			t.Fatalf("users=%#v audits=%#v commit=%d rollback=%d", db.users, db.audits, db.commitCalls, db.rollbackCalls)
		}
	})
}

func TestConcurrentInitialAdminCreationUsesPostgreSQLSingletonLock(t *testing.T) {
	pool := openIdentityTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	firstConnection, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer firstConnection.Release()
	secondConnection, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer secondConnection.Release()

	start := make(chan struct{})
	results := make(chan error, 2)
	var ready sync.WaitGroup
	ready.Add(2)
	for index, service := range []*Service{NewService(firstConnection), NewService(secondConnection)} {
		go func(index int, service *Service) {
			ready.Done()
			<-start
			_, err := service.CreateInitialAdmin(ctx, fmt.Sprintf("owner-%d", index), testPassword)
			results <- err
		}(index, service)
	}
	ready.Wait()
	close(start)

	var succeeded, alreadyExists int
	for range 2 {
		select {
		case err := <-results:
			switch {
			case err == nil:
				succeeded++
			case errors.Is(err, ErrAdminAlreadyExists):
				alreadyExists++
			default:
				t.Fatalf("concurrent bootstrap error = %v", err)
			}
		case <-ctx.Done():
			t.Fatalf("concurrent bootstrap timed out: %v", ctx.Err())
		}
	}
	if succeeded != 1 || alreadyExists != 1 {
		t.Fatalf("succeeded=%d alreadyExists=%d, want 1 and 1", succeeded, alreadyExists)
	}

	var administratorCount, auditCount int
	if err := pool.QueryRow(ctx, `select count(*) from users where role = 'admin' and status <> 'deleted'`).Scan(&administratorCount); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `select count(*) from audit_logs where action = 'admin.created'`).Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if administratorCount != 1 || auditCount != 1 {
		t.Fatalf("administrators=%d admin.created=%d, want 1 and 1", administratorCount, auditCount)
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
	nest     int
}

func (tx *memoryTx) Begin(context.Context) (pgx.Tx, error) {
	tx.nest++
	return tx, nil
}

func (tx *memoryTx) Commit(context.Context) error {
	if tx.closed {
		return pgx.ErrTxClosed
	}
	if tx.nest > 0 {
		tx.nest--
		return nil
	}
	tx.closed = true
	tx.parent.users = cloneUsers(tx.users)
	tx.parent.sessions = cloneSessions(tx.sessions)
	tx.parent.audits = append([]memoryAudit(nil), tx.audits...)
	tx.parent.commitCalls++
	return nil
}

func (tx *memoryTx) Rollback(context.Context) error {
	if tx.closed {
		return nil
	}
	if tx.nest > 0 {
		tx.nest--
		return nil
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
	case strings.Contains(sql, "update users") && strings.Contains(sql, "status"):
		id := args[0].(string)
		user, ok := tx.users[id]
		if !ok {
			return pgconn.NewCommandTag("UPDATE 0"), nil
		}
		user.status = args[1].(users.Status)
		user.updatedAt = args[2].(time.Time)
		tx.users[id] = user
		return pgconn.NewCommandTag("UPDATE 1"), nil
	case strings.Contains(sql, "update user_sessions"):
		userID := args[0].(string)
		preserveID := ""
		if len(args) >= 2 {
			if sessionID, ok := args[1].(string); ok {
				preserveID = sessionID
			}
		}
		var affected int
		for id, session := range tx.sessions {
			if session.userID == userID && !session.revoked && id != preserveID {
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
	case strings.Contains(sql, "from users") && strings.Contains(sql, "for update"):
		user, ok := tx.users[args[0].(string)]
		if !ok {
			return memoryRow{err: pgx.ErrNoRows}
		}
		return memoryRow{values: []any{user.role, user.status}}
	case strings.Contains(sql, "from users") && strings.Contains(sql, "where id = $1"):
		user, ok := tx.users[args[0].(string)]
		if !ok {
			return memoryRow{err: pgx.ErrNoRows}
		}
		return memoryRow{values: []any{user.id, user.username, user.role, user.status, user.createdAt, user.updatedAt, (*time.Time)(nil)}}
	case strings.Contains(sql, "count(*)") && strings.Contains(sql, "role = 'admin'") && strings.Contains(sql, "status = 'active'"):
		count := 0
		for _, user := range tx.users {
			if user.role == users.RoleAdmin && user.status == users.StatusActive {
				count++
			}
		}
		return memoryRow{values: []any{count}}
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

func seedMemoryUser(db *memoryDB, user users.User) {
	db.users[user.ID] = memoryUser{
		id:           user.ID,
		username:     user.Username,
		normalized:   strings.ToLower(user.Username),
		passwordHash: "existing-password-hash",
		role:         user.Role,
		status:       user.Status,
		createdAt:    time.Now().UTC(),
		updatedAt:    time.Now().UTC(),
	}
}

func findMemoryUserByUsername(db *memoryDB, username string) (memoryUser, bool) {
	for _, user := range db.users {
		if user.username == username {
			return user, true
		}
	}
	return memoryUser{}, false
}

var identitySchemaPattern = regexp.MustCompile(`^control_api_identity_test_[a-f0-9]{32}$`)

func openIdentityTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is not set; skipping PostgreSQL concurrency integration test")
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

	schema := newIdentityTestSchemaName(t)
	quotedSchema := quoteIdentityTestSchema(t, schema)
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
	config.MaxConns = 4
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

func newIdentityTestSchemaName(t *testing.T) string {
	t.Helper()
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		t.Fatalf("generate test schema name: %v", err)
	}
	return "control_api_identity_test_" + hex.EncodeToString(random)
}

func quoteIdentityTestSchema(t *testing.T, schema string) string {
	t.Helper()
	if !identitySchemaPattern.MatchString(schema) {
		t.Fatalf("unsafe test schema name %q", schema)
	}
	return fmt.Sprintf(`"%s"`, schema)
}
