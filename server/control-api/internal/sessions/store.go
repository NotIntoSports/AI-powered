// Package sessions persists revocable opaque sessions. Raw session tokens are
// returned once and are never stored.
package sessions

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"time"

	"github.com/ai-interviewer/ai-powered/control-api/internal/database"
	"github.com/ai-interviewer/ai-powered/control-api/internal/users"
	"github.com/jackc/pgx/v5"
)

var (
	ErrInvalidPurpose  = errors.New("invalid session purpose")
	ErrInvalidTTL      = errors.New("invalid session TTL")
	ErrUnauthenticated = errors.New("unauthenticated")
	ErrStore           = errors.New("session store unavailable")
)

const (
	PurposeBrowser = "browser"
	PurposeDesktop = "desktop"

	tokenSize        = 32
	lastUsedInterval = 5 * time.Minute
)

var rawTokenEncoding = base64.RawURLEncoding.Strict()

type Session struct {
	ID         string
	UserID     string
	Purpose    string
	DeviceID   string
	CreatedAt  time.Time
	ExpiresAt  time.Time
	LastUsedAt *time.Time
	RevokedAt  *time.Time
}

type CreateInput struct {
	UserID   string
	Purpose  string
	DeviceID string
	TTL      time.Duration
}

type Store struct {
	db database.DBTX
}

func NewStore(db database.DBTX) *Store {
	return &Store{db: db}
}

func (s *Store) Create(ctx context.Context, input CreateInput) (string, Session, error) {
	if !validPurpose(input.Purpose) {
		return "", Session{}, ErrInvalidPurpose
	}
	if input.TTL <= 0 {
		return "", Session{}, ErrInvalidTTL
	}

	var allowed bool
	if input.DeviceID == "" {
		if err := s.db.QueryRow(ctx, `
			select exists(
				select 1 from users where id = $1 and status = 'active'
			)
		`, input.UserID).Scan(&allowed); err != nil {
			return "", Session{}, ErrStore
		}
	} else {
		if err := s.db.QueryRow(ctx, `
			select exists(
				select 1
				from users as u
				join devices as d on d.user_id = u.id
				where u.id = $1 and u.status = 'active'
				  and d.id = $2 and d.disabled_at is null
			)
		`, input.UserID, input.DeviceID).Scan(&allowed); err != nil {
			return "", Session{}, ErrStore
		}
	}
	if !allowed {
		return "", Session{}, ErrUnauthenticated
	}

	rawTokenBytes := make([]byte, tokenSize)
	if _, err := rand.Read(rawTokenBytes); err != nil {
		return "", Session{}, ErrStore
	}
	rawToken := rawTokenEncoding.EncodeToString(rawTokenBytes)
	digest := sha256.Sum256([]byte(rawToken))
	id, err := randomSessionID()
	if err != nil {
		return "", Session{}, ErrStore
	}
	now := time.Now().UTC().Truncate(time.Microsecond)
	session := Session{}
	var deviceID any
	if input.DeviceID != "" {
		deviceID = input.DeviceID
	}
	err = s.db.QueryRow(ctx, `
		insert into user_sessions (
			id, user_id, token_digest, purpose, device_id, created_at, expires_at
		) values ($1, $2, $3, $4, $5, $6, $7)
		returning id, user_id, purpose, coalesce(device_id, ''), created_at,
		          expires_at, last_used_at, revoked_at
	`, id, input.UserID, digest[:], input.Purpose, deviceID, now, now.Add(input.TTL)).Scan(
		&session.ID,
		&session.UserID,
		&session.Purpose,
		&session.DeviceID,
		&session.CreatedAt,
		&session.ExpiresAt,
		&session.LastUsedAt,
		&session.RevokedAt,
	)
	if err != nil {
		return "", Session{}, ErrStore
	}
	return rawToken, session, nil
}

func (s *Store) Authenticate(ctx context.Context, rawToken, purpose string) (users.User, Session, error) {
	if !validPurpose(purpose) {
		return users.User{}, Session{}, ErrUnauthenticated
	}
	digest, ok := tokenDigest(rawToken)
	if !ok {
		return users.User{}, Session{}, ErrUnauthenticated
	}

	user := users.User{}
	session := Session{}
	var storedDigest []byte
	var deviceAllowed bool
	err := s.db.QueryRow(ctx, `
		select
			s.id, s.user_id, s.purpose, coalesce(s.device_id, ''), s.created_at,
			s.expires_at, s.last_used_at, s.revoked_at, s.token_digest,
			u.id, u.username, u.role, u.status, u.created_at, u.updated_at,
			u.last_login_at,
			case
				when s.device_id is null then true
				when d.id is not null and d.user_id = s.user_id and d.disabled_at is null then true
				else false
			end
		from user_sessions as s
		join users as u on u.id = s.user_id
		left join devices as d on d.id = s.device_id
		where s.token_digest = $1
	`, digest).Scan(
		&session.ID,
		&session.UserID,
		&session.Purpose,
		&session.DeviceID,
		&session.CreatedAt,
		&session.ExpiresAt,
		&session.LastUsedAt,
		&session.RevokedAt,
		&storedDigest,
		&user.ID,
		&user.Username,
		&user.Role,
		&user.Status,
		&user.CreatedAt,
		&user.UpdatedAt,
		&user.LastLoginAt,
		&deviceAllowed,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return users.User{}, Session{}, ErrUnauthenticated
	}
	if err != nil {
		return users.User{}, Session{}, ErrStore
	}

	now := time.Now().UTC().Truncate(time.Microsecond)
	if subtle.ConstantTimeCompare(storedDigest, digest) != 1 ||
		session.Purpose != purpose ||
		!session.ExpiresAt.After(now) ||
		session.RevokedAt != nil ||
		user.Status != users.StatusActive ||
		!deviceAllowed {
		return users.User{}, Session{}, ErrUnauthenticated
	}

	var updatedLastUsed time.Time
	err = s.db.QueryRow(ctx, `
		update user_sessions
		set last_used_at = $2::timestamptz
		where id = $1
		  and (last_used_at is null or last_used_at <= $2::timestamptz - interval '5 minutes')
		returning last_used_at
	`, session.ID, now).Scan(&updatedLastUsed)
	if err == nil {
		session.LastUsedAt = &updatedLastUsed
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return users.User{}, Session{}, ErrStore
	}
	return user, session, nil
}

func (s *Store) RevokeToken(ctx context.Context, rawToken string) error {
	digest, ok := tokenDigest(rawToken)
	if !ok {
		return ErrUnauthenticated
	}
	command, err := s.db.Exec(ctx, `
		update user_sessions
		set revoked_at = coalesce(revoked_at, $2)
		where token_digest = $1
	`, digest, time.Now().UTC().Truncate(time.Microsecond))
	if err != nil {
		return ErrStore
	}
	if command.RowsAffected() == 0 {
		return ErrUnauthenticated
	}
	return nil
}

func (s *Store) RevokeUser(ctx context.Context, userID string) error {
	return s.RevokeUserExcept(ctx, userID, "")
}

func (s *Store) RevokeUserExcept(ctx context.Context, userID, sessionID string) error {
	_, err := s.db.Exec(ctx, `
		update user_sessions
		set revoked_at = $3
		where user_id = $1 and revoked_at is null and ($2 = '' or id <> $2)
	`, userID, sessionID, time.Now().UTC().Truncate(time.Microsecond))
	if err != nil {
		return ErrStore
	}
	return nil
}

func tokenDigest(rawToken string) ([]byte, bool) {
	decoded, err := rawTokenEncoding.DecodeString(rawToken)
	if err != nil || len(decoded) != tokenSize {
		return nil, false
	}
	digest := sha256.Sum256([]byte(rawToken))
	return digest[:], true
}

func randomSessionID() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes), nil
}

func validPurpose(purpose string) bool {
	return purpose == PurposeBrowser || purpose == PurposeDesktop
}
