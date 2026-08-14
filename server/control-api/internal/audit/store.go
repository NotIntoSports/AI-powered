// Package audit appends security and identity events to the immutable audit
// table created by the database migrations.
package audit

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"reflect"
	"strings"
	"time"

	"github.com/ai-interviewer/ai-powered/control-api/internal/database"
)

var (
	ErrInvalidAction     = errors.New("invalid audit action")
	ErrInvalidEvent      = errors.New("invalid audit event")
	ErrInvalidMetadata   = errors.New("invalid audit metadata")
	ErrSensitiveMetadata = errors.New("audit metadata contains a sensitive key")
)

type Action string

const (
	ActionAdminCreated        Action = "admin.created"
	ActionUserCreated         Action = "user.created"
	ActionUserStatusChanged   Action = "user.status_changed"
	ActionUserPasswordReset   Action = "user.password_reset"
	ActionUserSessionsRevoked Action = "user.sessions_revoked"
	ActionLoginSucceeded      Action = "auth.login_succeeded"
	ActionLoginFailed         Action = "auth.login_failed"
	ActionLogout              Action = "auth.logout"
)

type Result string

const (
	ResultSuccess Result = "success"
	ResultFailure Result = "failure"
)

type Event struct {
	ActorUserID string
	Action      Action
	TargetType  string
	TargetID    string
	Result      Result
	RequestID   string
	SourceIP    string
	Metadata    map[string]any
	CreatedAt   time.Time
}

type Store struct {
	db database.DBTX
}

func NewStore(db database.DBTX) *Store {
	return &Store{db: db}
}

func (s *Store) Append(ctx context.Context, event Event) error {
	if !event.Action.valid() {
		return ErrInvalidAction
	}
	if event.TargetType == "" || event.RequestID == "" || !event.Result.valid() {
		return ErrInvalidEvent
	}
	if event.SourceIP != "" && net.ParseIP(event.SourceIP) == nil {
		return ErrInvalidEvent
	}
	if containsSensitiveMetadataKey(event.Metadata, make(map[visit]bool)) {
		return ErrSensitiveMetadata
	}
	if event.Metadata == nil {
		event.Metadata = map[string]any{}
	}
	encodedMetadata, err := json.Marshal(event.Metadata)
	if err != nil {
		return ErrInvalidMetadata
	}
	id, err := randomAuditID()
	if err != nil {
		return errors.New("generate audit event ID")
	}
	createdAt := event.CreatedAt.UTC().Truncate(time.Microsecond)
	if event.CreatedAt.IsZero() {
		createdAt = time.Now().UTC().Truncate(time.Microsecond)
	}

	_, err = s.db.Exec(ctx, `
		insert into audit_logs (
			id, actor_user_id, action, target_type, target_id, result,
			request_id, source_ip, metadata, created_at
		) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
	`,
		id,
		nullIfEmpty(event.ActorUserID),
		event.Action,
		event.TargetType,
		nullIfEmpty(event.TargetID),
		event.Result,
		event.RequestID,
		nullIfEmpty(event.SourceIP),
		string(encodedMetadata),
		createdAt,
	)
	if err != nil {
		return fmt.Errorf("append audit event: %w", err)
	}
	return nil
}

type visit struct {
	typ reflect.Type
	ptr uintptr
}

func containsSensitiveMetadataKey(value any, seen map[visit]bool) bool {
	return containsSensitiveValue(reflect.ValueOf(value), seen)
}

func containsSensitiveValue(value reflect.Value, seen map[visit]bool) bool {
	if !value.IsValid() {
		return false
	}
	for value.Kind() == reflect.Interface || value.Kind() == reflect.Pointer {
		if value.IsNil() {
			return false
		}
		if value.Kind() == reflect.Pointer {
			current := visit{typ: value.Type(), ptr: value.Pointer()}
			if seen[current] {
				return false
			}
			seen[current] = true
		}
		value = value.Elem()
	}

	switch value.Kind() {
	case reflect.Map:
		if value.IsNil() {
			return false
		}
		current := visit{typ: value.Type(), ptr: value.Pointer()}
		if seen[current] {
			return false
		}
		seen[current] = true
		iterator := value.MapRange()
		for iterator.Next() {
			key := iterator.Key()
			if key.Kind() == reflect.String && sensitiveMetadataKey(key.String()) {
				return true
			}
			if containsSensitiveValue(iterator.Value(), seen) {
				return true
			}
		}
	case reflect.Slice:
		if value.IsNil() {
			return false
		}
		current := visit{typ: value.Type(), ptr: value.Pointer()}
		if seen[current] {
			return false
		}
		seen[current] = true
		for index := 0; index < value.Len(); index++ {
			if containsSensitiveValue(value.Index(index), seen) {
				return true
			}
		}
	case reflect.Array:
		for index := 0; index < value.Len(); index++ {
			if containsSensitiveValue(value.Index(index), seen) {
				return true
			}
		}
	case reflect.Struct:
		typeOfValue := value.Type()
		for index := 0; index < value.NumField(); index++ {
			field := typeOfValue.Field(index)
			if !field.IsExported() {
				continue
			}
			name := field.Name
			if tag := field.Tag.Get("json"); tag != "" {
				tagName := strings.Split(tag, ",")[0]
				if tagName == "-" {
					continue
				}
				if tagName != "" {
					name = tagName
				}
			}
			if sensitiveMetadataKey(name) || containsSensitiveValue(value.Field(index), seen) {
				return true
			}
		}
	}
	return false
}

func sensitiveMetadataKey(key string) bool {
	for _, denied := range [...]string{"password", "token", "secret", "authorization", "api_key"} {
		if strings.EqualFold(key, denied) {
			return true
		}
	}
	return false
}

func randomAuditID() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes), nil
}

func nullIfEmpty(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func (action Action) valid() bool {
	switch action {
	case ActionAdminCreated,
		ActionUserCreated,
		ActionUserStatusChanged,
		ActionUserPasswordReset,
		ActionUserSessionsRevoked,
		ActionLoginSucceeded,
		ActionLoginFailed,
		ActionLogout:
		return true
	default:
		return false
	}
}

func (result Result) valid() bool {
	return result == ResultSuccess || result == ResultFailure
}
