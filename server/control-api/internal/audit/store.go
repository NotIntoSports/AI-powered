// Package audit appends security and identity events to the immutable audit
// table created by the database migrations.
package audit

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"strings"
	"time"

	"github.com/ai-interviewer/ai-powered/control-api/internal/database"
)

var (
	ErrInvalidAction     = errors.New("invalid audit action")
	ErrInvalidEvent      = errors.New("invalid audit event")
	ErrInvalidMetadata   = errors.New("invalid audit metadata")
	ErrSensitiveMetadata = errors.New("audit metadata contains a sensitive key")
	ErrStore             = errors.New("audit store unavailable")
)

type Action string

const (
	ActionAdminCreated           Action = "admin.created"
	ActionUserCreated            Action = "user.created"
	ActionUserStatusChanged      Action = "user.status_changed"
	ActionUserPasswordReset      Action = "user.password_reset"
	ActionUserSessionsRevoked    Action = "user.sessions_revoked"
	ActionLoginSucceeded         Action = "auth.login_succeeded"
	ActionLoginFailed            Action = "auth.login_failed"
	ActionLogout                 Action = "auth.logout"
	ActionAISettingsUpdated      Action = "settings.ai_updated"
	ActionAISettingsTested       Action = "settings.ai_tested"
	ActionRTCSettingsUpdated     Action = "settings.rtc_updated"
	ActionRTCSettingsTested      Action = "settings.rtc_tested"
	ActionStorageSettingsUpdated Action = "settings.storage_updated"
	ActionStorageSettingsTested  Action = "settings.storage_tested"
	ActionSpeechSettingsUpdated  Action = "settings.speech_updated"
	ActionSpeechSettingsTested   Action = "settings.speech_tested"
	ActionPipelineSettingsUpdated Action = "settings.pipeline_updated"
	ActionResumeUploaded         Action = "resume.uploaded"
	ActionResumeDeleted          Action = "resume.deleted"
	ActionResumeIndexed          Action = "resume.indexed"
	ActionResumeReindexed        Action = "resume.reindexed"
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
	encodedMetadata, err := encodeAndValidateMetadata(event.Metadata)
	if err != nil {
		return err
	}
	id, err := randomAuditID()
	if err != nil {
		return ErrStore
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
		return ErrStore
	}
	return nil
}

func encodeAndValidateMetadata(metadata map[string]any) ([]byte, error) {
	if metadata == nil {
		metadata = map[string]any{}
	}
	encoded, err := json.Marshal(metadata)
	if err != nil {
		return nil, ErrInvalidMetadata
	}

	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	var decoded any
	if err := decoder.Decode(&decoded); err != nil {
		return nil, ErrInvalidMetadata
	}
	if _, ok := decoded.(map[string]any); !ok {
		return nil, ErrInvalidMetadata
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, ErrInvalidMetadata
	}
	if containsSensitiveJSONKey(decoded) {
		return nil, ErrSensitiveMetadata
	}
	return encoded, nil
}

func containsSensitiveJSONKey(value any) bool {
	switch typed := value.(type) {
	case map[string]any:
		for key, nested := range typed {
			if sensitiveMetadataKey(key) || containsSensitiveJSONKey(nested) {
				return true
			}
		}
	case []any:
		for _, nested := range typed {
			if containsSensitiveJSONKey(nested) {
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
		ActionLogout,
		ActionAISettingsUpdated,
		ActionAISettingsTested,
		ActionRTCSettingsUpdated,
		ActionRTCSettingsTested,
		ActionStorageSettingsUpdated,
		ActionStorageSettingsTested,
		ActionSpeechSettingsUpdated,
		ActionSpeechSettingsTested,
		ActionPipelineSettingsUpdated,
		ActionResumeUploaded,
		ActionResumeDeleted,
		ActionResumeIndexed,
		ActionResumeReindexed:
		return true
	default:
		return false
	}
}

func (result Result) valid() bool {
	return result == ResultSuccess || result == ResultFailure
}
