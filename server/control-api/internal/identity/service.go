// Package identity coordinates password, user, session, and audit persistence
// inside atomic identity-management operations.
package identity

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"

	"github.com/ai-interviewer/ai-powered/control-api/internal/audit"
	"github.com/ai-interviewer/ai-powered/control-api/internal/database"
	"github.com/ai-interviewer/ai-powered/control-api/internal/password"
	"github.com/ai-interviewer/ai-powered/control-api/internal/sessions"
	"github.com/ai-interviewer/ai-powered/control-api/internal/users"
	"github.com/jackc/pgx/v5"
)

var (
	ErrAdminAlreadyExists = errors.New("administrator already exists")
	ErrForbidden          = errors.New("forbidden")
	ErrService            = errors.New("identity service unavailable")
)

const (
	bootstrapLockNamespace int32 = 0x43415049
	bootstrapLockObject    int32 = 2
)

type Service struct {
	db database.DBTX
}

func NewService(db database.DBTX) *Service {
	return &Service{db: db}
}

func (s *Service) CreateInitialAdmin(ctx context.Context, username, plainPassword string) (users.User, error) {
	requestID, err := newRequestID()
	if err != nil {
		return users.User{}, ErrService
	}

	var created users.User
	err = pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `select pg_advisory_xact_lock($1, $2)`, bootstrapLockNamespace, bootstrapLockObject); err != nil {
			return ErrService
		}

		var administrators int
		if err := tx.QueryRow(ctx, `
			select count(*)
			from users
			where role = 'admin' and status <> 'deleted'
		`).Scan(&administrators); err != nil {
			return ErrService
		}
		if administrators != 0 {
			return ErrAdminAlreadyExists
		}

		encodedPassword, err := password.Hash(plainPassword)
		if err != nil {
			return passwordError(err)
		}
		created, err = users.NewStore(tx).Create(ctx, users.CreateInput{
			Username:     username,
			PasswordHash: encodedPassword,
			Role:         users.RoleAdmin,
		})
		if err != nil {
			return userError(err)
		}
		if err := audit.NewStore(tx).Append(ctx, audit.Event{
			ActorUserID: created.ID,
			Action:      audit.ActionAdminCreated,
			TargetType:  "user",
			TargetID:    created.ID,
			Result:      audit.ResultSuccess,
			RequestID:   requestID,
			Metadata:    map[string]any{"role": string(users.RoleAdmin)},
		}); err != nil {
			return ErrService
		}
		return nil
	})
	if err != nil {
		return users.User{}, identityError(err)
	}
	return created, nil
}

func (s *Service) CreateOperator(ctx context.Context, actor users.User, username, plainPassword string) (users.User, error) {
	return s.CreateUser(ctx, actor, username, plainPassword, users.RoleOperator)
}

func (s *Service) CreateUser(ctx context.Context, actor users.User, username, plainPassword string, role users.Role) (users.User, error) {
	requestID, err := newRequestID()
	if err != nil {
		return users.User{}, ErrService
	}

	var created users.User
	err = pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		if err := requireActiveAdministrator(ctx, tx, actor.ID); err != nil {
			return err
		}
		encodedPassword, err := password.Hash(plainPassword)
		if err != nil {
			return passwordError(err)
		}
		created, err = users.NewStore(tx).Create(ctx, users.CreateInput{
			Username:     username,
			PasswordHash: encodedPassword,
			Role:         role,
		})
		if err != nil {
			return userError(err)
		}
		if err := audit.NewStore(tx).Append(ctx, audit.Event{
			ActorUserID: actor.ID,
			Action:      audit.ActionUserCreated,
			TargetType:  "user",
			TargetID:    created.ID,
			Result:      audit.ResultSuccess,
			RequestID:   requestID,
			Metadata:    map[string]any{"role": string(role)},
		}); err != nil {
			return ErrService
		}
		return nil
	})
	if err != nil {
		return users.User{}, identityError(err)
	}
	return created, nil
}

func (s *Service) ListUsers(ctx context.Context, actor users.User) ([]users.User, error) {
	var listed []users.User
	err := pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		if err := requireActiveAdministrator(ctx, tx, actor.ID); err != nil {
			return err
		}
		var err error
		listed, err = users.NewStore(tx).List(ctx)
		if err != nil {
			return userError(err)
		}
		return nil
	})
	if err != nil {
		return nil, identityError(err)
	}
	return listed, nil
}

func (s *Service) SetUserStatus(ctx context.Context, actor users.User, userID string, status users.Status) error {
	requestID, err := newRequestID()
	if err != nil {
		return ErrService
	}

	err = pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		if err := requireActiveAdministrator(ctx, tx, actor.ID); err != nil {
			return err
		}
		if err := users.NewStore(tx).SetStatus(ctx, userID, status); err != nil {
			return userError(err)
		}
		if status == users.StatusDisabled {
			if err := sessions.NewStore(tx).RevokeUser(ctx, userID); err != nil {
				return ErrService
			}
		}
		if err := audit.NewStore(tx).Append(ctx, audit.Event{
			ActorUserID: actor.ID,
			Action:      audit.ActionUserStatusChanged,
			TargetType:  "user",
			TargetID:    userID,
			Result:      audit.ResultSuccess,
			RequestID:   requestID,
			Metadata:    map[string]any{"status": string(status)},
		}); err != nil {
			return ErrService
		}
		return nil
	})
	return identityError(err)
}

func (s *Service) RevokeUserSessions(ctx context.Context, actor users.User, userID, preserveSessionID string) error {
	requestID, err := newRequestID()
	if err != nil {
		return ErrService
	}

	err = pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		if err := requireActiveAdministrator(ctx, tx, actor.ID); err != nil {
			return err
		}
		if _, err := users.NewStore(tx).Get(ctx, userID); err != nil {
			return userError(err)
		}
		if err := sessions.NewStore(tx).RevokeUserExcept(ctx, userID, preserveSessionID); err != nil {
			return ErrService
		}
		if err := audit.NewStore(tx).Append(ctx, audit.Event{
			ActorUserID: actor.ID,
			Action:      audit.ActionUserSessionsRevoked,
			TargetType:  "user",
			TargetID:    userID,
			Result:      audit.ResultSuccess,
			RequestID:   requestID,
			Metadata:    map[string]any{"preserveCurrent": preserveSessionID != ""},
		}); err != nil {
			return ErrService
		}
		return nil
	})
	return identityError(err)
}

func (s *Service) ResetPassword(ctx context.Context, actor users.User, userID, plainPassword string) error {
	requestID, err := newRequestID()
	if err != nil {
		return ErrService
	}

	err = pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		if err := requireActiveAdministrator(ctx, tx, actor.ID); err != nil {
			return err
		}
		encodedPassword, err := password.Hash(plainPassword)
		if err != nil {
			return passwordError(err)
		}
		if err := users.NewStore(tx).ReplacePassword(ctx, userID, encodedPassword); err != nil {
			return userError(err)
		}
		if err := sessions.NewStore(tx).RevokeUser(ctx, userID); err != nil {
			return ErrService
		}
		if err := audit.NewStore(tx).Append(ctx, audit.Event{
			ActorUserID: actor.ID,
			Action:      audit.ActionUserPasswordReset,
			TargetType:  "user",
			TargetID:    userID,
			Result:      audit.ResultSuccess,
			RequestID:   requestID,
		}); err != nil {
			return ErrService
		}
		return nil
	})
	return identityError(err)
}

func requireActiveAdministrator(ctx context.Context, tx pgx.Tx, actorID string) error {
	var role users.Role
	var status users.Status
	err := tx.QueryRow(ctx, `
		select role, status
		from users
		where id = $1
		for update
	`, actorID).Scan(&role, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrForbidden
	}
	if err != nil {
		return ErrService
	}
	if role != users.RoleAdmin || status != users.StatusActive {
		return ErrForbidden
	}
	return nil
}

func newRequestID() (string, error) {
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	return "identity-" + hex.EncodeToString(random), nil
}

func passwordError(err error) error {
	if errors.Is(err, password.ErrInvalidPassword) {
		return password.ErrInvalidPassword
	}
	return ErrService
}

func userError(err error) error {
	for _, known := range []error{
		users.ErrInvalidUsername,
		users.ErrInvalidRole,
		users.ErrInvalidStatus,
		users.ErrInvalidPassword,
		users.ErrUsernameTaken,
		users.ErrUserNotFound,
		users.ErrLastAdmin,
	} {
		if errors.Is(err, known) {
			return known
		}
	}
	return ErrService
}

func identityError(err error) error {
	if err == nil {
		return nil
	}
	for _, known := range []error{
		ErrAdminAlreadyExists,
		ErrForbidden,
		ErrService,
		password.ErrInvalidPassword,
		users.ErrInvalidUsername,
		users.ErrInvalidRole,
		users.ErrInvalidStatus,
		users.ErrInvalidPassword,
		users.ErrUsernameTaken,
		users.ErrUserNotFound,
		users.ErrLastAdmin,
	} {
		if errors.Is(err, known) {
			return known
		}
	}
	return ErrService
}
