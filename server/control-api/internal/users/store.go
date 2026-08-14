// Package users persists control API users without exposing password hashes in
// the public user model.
package users

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/ai-interviewer/ai-powered/control-api/internal/database"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

var (
	ErrInvalidUsername = errors.New("invalid username")
	ErrInvalidRole     = errors.New("invalid user role")
	ErrInvalidStatus   = errors.New("invalid user status")
	ErrInvalidPassword = errors.New("invalid encoded password")
	ErrUsernameTaken   = errors.New("username is already taken")
	ErrUserNotFound    = errors.New("user not found")
	ErrLastAdmin       = errors.New("last active administrator is required")
	ErrStore           = errors.New("user store unavailable")
)

const (
	// PostgreSQL's two-key advisory lock namespace is shared by every user
	// status transition. The fixed CAPI/1 key gives every caller the same lock
	// order before it reads the active-administrator set.
	userStatusLockNamespace int32 = 0x43415049
	userStatusLockObject    int32 = 1
)

type Role string

const (
	RoleAdmin    Role = "admin"
	RoleOperator Role = "operator"
)

type Status string

const (
	StatusActive   Status = "active"
	StatusDisabled Status = "disabled"
	StatusDeleted  Status = "deleted"
)

type User struct {
	ID          string
	Username    string
	Role        Role
	Status      Status
	CreatedAt   time.Time
	UpdatedAt   time.Time
	LastLoginAt *time.Time
}

type UserWithPassword struct {
	User
	PasswordHash string
}

type CreateInput struct {
	Username     string
	PasswordHash string
	Role         Role
}

type Store struct {
	db database.DBTX
}

func NewStore(db database.DBTX) *Store {
	return &Store{db: db}
}

func (s *Store) Create(ctx context.Context, input CreateInput) (User, error) {
	username, normalized, err := normalizeUsername(input.Username)
	if err != nil {
		return User{}, err
	}
	if !input.Role.valid() {
		return User{}, ErrInvalidRole
	}
	if input.PasswordHash == "" {
		return User{}, ErrInvalidPassword
	}

	id, err := randomID()
	if err != nil {
		return User{}, ErrStore
	}
	now := time.Now().UTC().Truncate(time.Microsecond)
	user := User{}
	err = s.db.QueryRow(ctx, `
		insert into users (
			id, username, username_normalized, password_hash, role, status,
			created_at, updated_at
		) values ($1, $2, $3, $4, $5, $6, $7, $7)
		returning id, username, role, status, created_at, updated_at, last_login_at
	`, id, username, normalized, input.PasswordHash, input.Role, StatusActive, now).Scan(
		&user.ID,
		&user.Username,
		&user.Role,
		&user.Status,
		&user.CreatedAt,
		&user.UpdatedAt,
		&user.LastLoginAt,
	)
	if err == nil {
		return user, nil
	}
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) && postgresError.Code == "23505" && postgresError.ConstraintName == "users_username_normalized_key" {
		return User{}, ErrUsernameTaken
	}
	return User{}, ErrStore
}

func (s *Store) GetByNormalizedUsername(ctx context.Context, normalized string) (UserWithPassword, error) {
	_, normalized, err := normalizeUsername(normalized)
	if err != nil {
		return UserWithPassword{}, ErrUserNotFound
	}

	user := UserWithPassword{}
	err = s.db.QueryRow(ctx, `
		select id, username, role, status, created_at, updated_at, last_login_at, password_hash
		from users
		where username_normalized = $1
	`, normalized).Scan(
		&user.ID,
		&user.Username,
		&user.Role,
		&user.Status,
		&user.CreatedAt,
		&user.UpdatedAt,
		&user.LastLoginAt,
		&user.PasswordHash,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return UserWithPassword{}, ErrUserNotFound
	}
	if err != nil {
		return UserWithPassword{}, ErrStore
	}
	return user, nil
}

func (s *Store) List(ctx context.Context) ([]User, error) {
	rows, err := s.db.Query(ctx, `
		select id, username, role, status, created_at, updated_at, last_login_at
		from users
		order by created_at, id
	`)
	if err != nil {
		return nil, ErrStore
	}
	defer rows.Close()

	users := make([]User, 0)
	for rows.Next() {
		user := User{}
		if err := rows.Scan(
			&user.ID,
			&user.Username,
			&user.Role,
			&user.Status,
			&user.CreatedAt,
			&user.UpdatedAt,
			&user.LastLoginAt,
		); err != nil {
			return nil, ErrStore
		}
		users = append(users, user)
	}
	if err := rows.Err(); err != nil {
		return nil, ErrStore
	}
	return users, nil
}

func (s *Store) SetStatus(ctx context.Context, id string, status Status) error {
	if !status.valid() {
		return ErrInvalidStatus
	}

	err := pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `select pg_advisory_xact_lock($1, $2)`, userStatusLockNamespace, userStatusLockObject); err != nil {
			return ErrStore
		}

		var role Role
		var current Status
		err := tx.QueryRow(ctx, `
			select role, status
			from users
			where id = $1
			for update
		`, id).Scan(&role, &current)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrUserNotFound
		}
		if err != nil {
			return ErrStore
		}

		if role == RoleAdmin && current == StatusActive && status != StatusActive {
			var activeAdmins int
			if err := tx.QueryRow(ctx, `
				select count(*)
				from users
				where role = 'admin' and status = 'active'
			`).Scan(&activeAdmins); err != nil {
				return ErrStore
			}
			if activeAdmins <= 1 {
				return ErrLastAdmin
			}
		}

		command, err := tx.Exec(ctx, `
			update users
			set status = $2, updated_at = $3
			where id = $1
		`, id, status, time.Now().UTC().Truncate(time.Microsecond))
		if err != nil || command.RowsAffected() != 1 {
			return ErrStore
		}
		return nil
	})
	if err == nil {
		return nil
	}
	if errors.Is(err, ErrUserNotFound) {
		return ErrUserNotFound
	}
	if errors.Is(err, ErrLastAdmin) {
		return ErrLastAdmin
	}
	return ErrStore
}

func (s *Store) ReplacePassword(ctx context.Context, id, encoded string) error {
	if encoded == "" {
		return ErrInvalidPassword
	}
	command, err := s.db.Exec(ctx, `
		update users
		set password_hash = $2, updated_at = $3
		where id = $1
	`, id, encoded, time.Now().UTC().Truncate(time.Microsecond))
	if err != nil {
		return ErrStore
	}
	if command.RowsAffected() == 0 {
		return ErrUserNotFound
	}
	return nil
}

func normalizeUsername(raw string) (string, string, error) {
	username := strings.TrimSpace(raw)
	if !utf8.ValidString(username) {
		return "", "", ErrInvalidUsername
	}
	normalized := strings.ToLower(username)
	runeCount := utf8.RuneCountInString(normalized)
	if runeCount < 3 || runeCount > 64 {
		return "", "", ErrInvalidUsername
	}
	for _, char := range normalized {
		if !unicode.IsLetter(char) && !unicode.IsDigit(char) && char != '.' && char != '_' && char != '-' {
			return "", "", ErrInvalidUsername
		}
	}
	return username, normalized, nil
}

func randomID() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes), nil
}

func (role Role) valid() bool {
	return role == RoleAdmin || role == RoleOperator
}

func (status Status) valid() bool {
	return status == StatusActive || status == StatusDisabled || status == StatusDeleted
}
